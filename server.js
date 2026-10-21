/**
 * pw-billing-forecast — server
 *
 * A thin server with three jobs:
 *   1. Serve the static grid UI (public/index.html)
 *   2. Hold the Projectworks Open API credentials and proxy a small,
 *      fixed set of calls. The browser never sees the credentials.
 *   3. Read and write the app-side consultant plan and audit trail in Postgres.
 *
 * Endpoints:
 *   GET  /healthz                — unauthenticated database-backed host probe
 *   GET  /api/health              — config sanity check for the UI
 *   GET  /api/users               — safe Projectworks user picker data
 *   GET  /api/offices             — the tenant's organisations (offices), cached
 *   GET  /api/grid?start&end[&office=<OfficeID>|all][&ifCached=1][&fresh=1]
 *                                 — { rows, netRows, supplierLines, meta }
 *                                   Built from the window's last good
 *                                   snapshot (memory, then Postgres); read in
 *                                   the foreground only when there is none.
 *                                   Snapshots hold active projects only, and
 *                                   the office filter is applied server-side,
 *                                   before any row is built or sent.
 *                                   netRows is the read-only Net position view:
 *                                   one row per project, planned invoicing minus
 *                                   subconsultant fees, per month.
 *   POST /api/grid/refresh?start&end[&full=1] — start a background refresh
 *                                   ("Load data"): incremental after the
 *                                   first full sync, full with full=1
 *   GET  /api/grid/refresh?start&end — its progress, per phase (no errors:
 *                                   those are logged server-side only)
 *   POST /api/forecast            — { moduleID, month:"YYYY-MM", amount, selectedProjectworksUserID, context }
 *                                   → POST /api/v1/Forecasts/Set. SERVICES
 *                                   MODULES ONLY: a non-services (consultant)
 *                                   module is rejected, see below.
 *   GET  /api/supplier-lines      — app-side supplier lines (Postgres)
 *   POST /api/supplier-lines      — { moduleID, supplier, selectedProjectworksUserID, context }
 *   PUT  /api/supplier-lines/:id/month — { month, amount, selectedProjectworksUserID, context }
 *                                   sets the line's month cell, app-side only
 *   DELETE /api/supplier-lines/:id
 *   GET  /api/audit               — newest audit entries (max 100)
 *
 * Two kinds of number, two homes:
 *
 *   Gross fees (services modules)      — what the customer plans to INVOICE its
 *     clients. Projectworks Forecasts is the field of record; this app reads
 *     and writes it through POST /api/v1/Forecasts/Set.
 *
 *   Consultant fees (non-services)     — subconsultant fees the customer expects
 *     to be CHARGED. Planning numbers only. They live in Postgres and
 *     are NEVER written to Projectworks: the Forecast screen represents money
 *     coming in, and an incoming cost posted there misstates it. There is
 *     exactly one caller of pwSetForecast(), the /api/forecast route, and it
 *     refuses any module that is not IsServices.
 *
 * All mutations (forecast AND supplier-line) are blocked unless
 * ALLOW_WRITES=true.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { createStorage, readStorageConfig } = require('./storage');
const {
  aggregateExpenseActuals,
  aggregateForecasts,
  aggregateInvoiceFees,
  buildNetRows,
  compareTenantOfficeNames,
  firstValue,
  isArchivedProject,
  isMonth,
  moduleMonthTotals,
  parseList,
  fetchModulesByProject,
  mergeModuleChanges,
  projectModuleIDs,
  resolveExpenseStatusFilter,
  resolveModuleCustomFields,
  summarizeInvoiceStatuses,
} = require('./app-logic');
const { createProjectworksClient } = require('./pw-client');

const BASE_URL = (process.env.PW_BASE_URL || '').replace(/\/+$/, '');
const APP_BASE_URL = (process.env.PW_APP_BASE_URL || '').replace(/\/+$/, '');
const AUTH_MODE = (process.env.AUTH_MODE || '').toLowerCase();
const TENANT_LOCK_NAMES = parseList(process.env.PW_TENANT_LOCK);
const TENANT_LOCK = TENANT_LOCK_NAMES.join(', ');
const ALLOW_WRITES = process.env.ALLOW_WRITES === 'true';
const STORAGE_CONFIG = readStorageConfig();
const SEED_DEMO_DATA = process.env.SEED_DEMO_DATA === 'true';
const SEED_PATH = path.join(__dirname, 'seed.json');
// Every list variable is comma-separated with surrounding whitespace trimmed,
// so "Stage No, Risk Status , Des / Del" and "Stage No,Risk Status,Des / Del"
// read identically.
const STATUS_CODES = parseList(process.env.INVOICE_STATUS_CODES);
const EXPENSE_STATUS_CODES = parseList(process.env.EXPENSE_STATUS_CODES);
// Names may be given instead of IDs; see resolveExpenseStatusFilter.
const EXPENSE_STATUS_FILTER = resolveExpenseStatusFilter(EXPENSE_STATUS_CODES);
const MODULE_CUSTOM_FIELD_LABELS = parseList(process.env.MODULE_CUSTOM_FIELD_LABELS);
// Project workflow statuses that mean "archived". Optional; SJB archives
// through the "Archived" status rather than IsActive=false.
const ARCHIVED_PROJECT_STATUSES = parseList(process.env.ARCHIVED_PROJECT_STATUSES || 'Archived');
const MODULE_CUSTOM_FIELD_KEYS = ['stageNumber', 'riskStatus', 'fixedHourly'];
const MODULE_CUSTOM_FIELDS = MODULE_CUSTOM_FIELD_KEYS.map((key, index) => ({
  key,
  label: MODULE_CUSTOM_FIELD_LABELS[index] || '',
}));
const MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID = String(process.env.MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID || '').trim();
const DEFAULT_STAGE_SORT = String(process.env.DEFAULT_STAGE_SORT || '').trim();
const PW_REQUEST_TIMEOUT_MS = Number(process.env.PW_REQUEST_TIMEOUT_MS);
// Modules are read one GET /Modules?ProjectID= per active project, this many
// at a time (optional, default 10).
const MODULE_FETCH_CONCURRENCY = Number(process.env.MODULE_FETCH_CONCURRENCY) || 10;
// Optional, default 24. After a full sync, refreshes read only the modules
// changed since the last one (ModifiedSinceDate); a full sync runs again once
// the last is this many hours old, as a backstop for edits that do not bump
// ModifiedDateUTC.
const FULL_SYNC_INTERVAL_MS = (Number(process.env.FULL_SYNC_INTERVAL_HOURS) || 24) * 60 * 60 * 1000;
// ModifiedSinceDate is compared with the API's clock, not ours: read back this
// far before the previous sync started so clock skew cannot lose a change.
const MODIFIED_SINCE_OVERLAP_MS = 15 * 60 * 1000;

// Hosted deployments hand the port in via the environment and require binding
// to every interface; 0.0.0.0 is not configurable on purpose.
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// ---- boot config checks ----------------------------------------------------
// Everything the app needs comes from the environment. There are no fallback
// values for the base URL, credentials or tenant: a missing one is a hard stop
// that names the variable, never a silent default.

function refuseToStart(lines) {
  console.error('\npw-billing-forecast refused to start:\n');
  for (const line of lines) console.error(`  ${line}`);
  console.error('\nSee .env.example for every variable this app reads.\n');
  process.exit(1);
}

function isSecureServiceUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  } catch {
    return false;
  }
}

const missingConfig = [];
if (!BASE_URL) missingConfig.push('PW_BASE_URL is not set (Projectworks Open API base URL).');
else if (!isSecureServiceUrl(BASE_URL)) missingConfig.push('PW_BASE_URL must be a valid HTTPS URL (HTTP is allowed only for localhost testing).');
if (APP_BASE_URL && !isSecureServiceUrl(APP_BASE_URL)) {
  missingConfig.push('PW_APP_BASE_URL must be a valid HTTPS URL when set.');
}
if (!Number.isSafeInteger(PW_REQUEST_TIMEOUT_MS) || PW_REQUEST_TIMEOUT_MS < 1000 || PW_REQUEST_TIMEOUT_MS > 120000) {
  missingConfig.push('PW_REQUEST_TIMEOUT_MS must be an integer from 1000 to 120000.');
}
if (!TENANT_LOCK_NAMES.length) {
  missingConfig.push(
    'PW_TENANT_LOCK is not set (the expected Projectworks tenant identity — one or ' +
    'more comma-separated office names configured in that tenant). Without it the server cannot tell which tenant ' +
    'the credential belongs to, so it will not start.'
  );
}
if (!['basic', 'header'].includes(AUTH_MODE)) {
  missingConfig.push('AUTH_MODE must be set to "basic" or "header".');
} else if (AUTH_MODE === 'basic') {
  if (!process.env.PW_USERNAME) missingConfig.push('PW_USERNAME is not set (required when AUTH_MODE=basic).');
  if (!process.env.PW_PASSWORD) missingConfig.push('PW_PASSWORD is not set (required when AUTH_MODE=basic).');
} else {
  if (!process.env.PW_AUTH_HEADER_NAME) missingConfig.push('PW_AUTH_HEADER_NAME is not set (required when AUTH_MODE=header).');
  if (!process.env.PW_AUTH_HEADER_VALUE) missingConfig.push('PW_AUTH_HEADER_VALUE is not set (required when AUTH_MODE=header).');
}
if (!EXPENSE_STATUS_CODES.length) {
  missingConfig.push('EXPENSE_STATUS_CODES is not set (approved expense-claim status IDs for Consultant Fees to Date).');
}
if (!STATUS_CODES.length) {
  missingConfig.push('INVOICE_STATUS_CODES is not set (approved invoice statuses for Gross Fees to Date).');
}
if (MODULE_CUSTOM_FIELD_LABELS.length !== MODULE_CUSTOM_FIELD_KEYS.length) {
  missingConfig.push('MODULE_CUSTOM_FIELD_LABELS must contain exactly three comma-separated labels: Stage Number, Risk Status, Fixed / Hourly.');
}
if (!['stageName', 'stageNumber'].includes(DEFAULT_STAGE_SORT)) {
  missingConfig.push('DEFAULT_STAGE_SORT must be "stageName" or "stageNumber".');
}
missingConfig.push(...STORAGE_CONFIG.errors);
if (missingConfig.length) refuseToStart(missingConfig);

const storage = createStorage(STORAGE_CONFIG);

function authHeaders() {
  if (AUTH_MODE === 'basic') {
    const token = Buffer.from(`${process.env.PW_USERNAME}:${process.env.PW_PASSWORD}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  return { [process.env.PW_AUTH_HEADER_NAME]: process.env.PW_AUTH_HEADER_VALUE };
}

// ---- browser-facing gate (HTTP Basic) --------------------------------------
// This app is deployed on a public URL with a live API token and write access,
// so every user-facing route, including the static file handler, sits behind
// this gate. /healthz is the sole exception and returns no tenant data. The
// gate fails closed: no password, no server, unless AUTH_DISABLED=true says so.
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || '';
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD || '';

if (!AUTH_DISABLED) {
  const missingAuth = [];
  if (!BASIC_AUTH_USER) missingAuth.push('BASIC_AUTH_USER is not set (username for the browser login prompt).');
  if (!BASIC_AUTH_PASSWORD) missingAuth.push('BASIC_AUTH_PASSWORD is not set (password for the browser login prompt).');
  if (missingAuth.length) {
    refuseToStart([
      ...missingAuth,
      '',
      'Every user-facing route is gated behind HTTP Basic auth. Set both',
      'variables, or set',
      'AUTH_DISABLED=true to run with no gate at all (local development only).',
    ]);
  }
}

/**
 * Constant-time string compare. Hashing first gives both sides a fixed 32-byte
 * length, so timingSafeEqual never throws on a length mismatch and the length
 * of the real credential does not leak.
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function challenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="pw-billing-forecast", charset="UTF-8"');
  return res.status(401).type('text/plain').send('Authentication required.');
}

function requireBasicAuth(req, res, next) {
  if (AUTH_DISABLED) return next();
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (!encoded || !/^basic$/i.test(scheme)) return challenge(res);

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return challenge(res);
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return challenge(res);

  // Both comparisons run before the decision, so a wrong username costs the
  // same as a wrong password.
  const userOk = safeEqual(decoded.slice(0, sep), BASIC_AUTH_USER);
  const passOk = safeEqual(decoded.slice(sep + 1), BASIC_AUTH_PASSWORD);
  if (userOk && passOk) return next();
  return challenge(res);
}

// ---- app-side store (supplier lines + audit) ------------------------------
// Projectworks has no supplier grain in forecasts, and subconsultant fees are
// incoming costs that do not belong on the Forecast screen. Postgres is the
// only runtime store for supplier lines and audit entries; data/store.json is
// retained solely as the source for the one-time migration.

// ---- Projectworks proxy ----------------------------------------------------
// Every collection is read through pw-client, which takes the page count from
// the API's x-page-count header and checks the result against x-total-count.
// 1000 is the largest page the Open API honours (it silently caps larger
// requests). Pages of one collection are fetched six at a time, and at most
// twelve requests are in flight across the app. Retries are logged here only.
const pw = createProjectworksClient({
  baseUrl: BASE_URL,
  authHeaders,
  timeoutMs: PW_REQUEST_TIMEOUT_MS,
  pageSize: 1000,
  pageConcurrency: 6,
  maxConcurrent: 12,
  onRetry: ({ pathname, params, attempt, delayMs, error }) => {
    const query = new URLSearchParams(Object.entries(params || {}).filter(([k]) => k !== 'pageSize')).toString();
    console.warn(`Projectworks retry ${attempt} in ${delayMs}ms: GET ${pathname}${query ? `?${query}` : ''}: ${error.slice(0, 200)}`);
  },
});
const USER_PAGE_SIZE = 500;
const USER_CACHE_MS = 5 * 60 * 1000;
let usersCache = { at: 0, users: [], byID: new Map() };

const pwGet = (pathname, params) => pw.get(pathname, params);
/** Every record, or an IncompleteCollectionError. Used wherever partial data must stop the action. */
const pwGetAll = (pathname, params, opts) => pw.getAll(pathname, params, opts);

// ---- reference-data cache --------------------------------------------------
// Offices, custom-field definitions and projects (which carry the PM, type,
// status and office names the filters use) change rarely, so a grid load or a
// filter change does not re-read them. Concurrent callers share one in-flight
// request instead of each starting their own.
const REFERENCE_CACHE_MS = 10 * 60 * 1000;
const PROJECTS_CACHE_MS = 5 * 60 * 1000;
const referenceCache = new Map();

function cached(key, ttlMs, loader, { force = false } = {}) {
  const hit = referenceCache.get(key);
  if (!force && hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.promise;
  const entry = { at: Date.now(), pending: true };
  entry.promise = Promise.resolve().then(loader).then(
    (value) => { entry.pending = false; entry.at = Date.now(); return value; },
    (err) => { if (referenceCache.get(key) === entry) referenceCache.delete(key); throw err; }
  );
  referenceCache.set(key, entry);
  return entry.promise;
}

function primeCache(key, value) {
  referenceCache.set(key, { at: Date.now(), pending: false, promise: Promise.resolve(value) });
}

// Only the project fields the app reads. The full record also carries
// CustomFields, which would hold tens of MB in memory. Its Modules list is a
// plain array of ModuleIDs, kept as ModuleIDs: it is the exact expected module
// set each per-project read is checked against, and what reveals deletions on
// an incremental refresh.
function slimProject(p) {
  const moduleIDs = projectModuleIDs(p);
  return {
    ProjectID: firstValue(p, ['ProjectID', 'projectID']),
    ProjectNumber: firstValue(p, ['ProjectNumber', 'projectNumber']),
    ProjectName: firstValue(p, ['ProjectName', 'projectName']),
    OfficeID: firstValue(p, ['OfficeID', 'officeID']),
    OfficeName: firstValue(p, ['OfficeName', 'officeName']),
    ProjectManagerName: firstValue(p, ['ProjectManagerName', 'projectManagerName']),
    ProjectTypeName: firstValue(p, ['ProjectTypeName', 'projectTypeName']),
    ProjectStatusName: firstValue(p, ['ProjectStatusName', 'projectStatusName']),
    IsActive: firstValue(p, ['IsActive', 'isActive']),
    CurrencyID: firstValue(p, ['CurrencyID', 'currencyID']),
    CurrencyCode: firstValue(p, ['CurrencyCode', 'currencyCode']),
    ...(moduleIDs ? { ModuleIDs: moduleIDs.map(Number) } : {}),
  };
}

// Modules come back with their Tasks; the grid never reads them. Each custom
// field entry keeps only what resolveModuleCustomFields reads (label, ID,
// entity type, value), and every entry stays in place so the ordinal fallback
// still lines up. Snapshots of ~28,000 modules live in memory on a 512 MB host.
const CUSTOM_FIELD_ENTRY_KEYS = [
  'Label', 'label', 'FieldLabel', 'fieldLabel', 'Name', 'name',
  'FieldID', 'fieldID', 'fieldId', 'CustomFieldID', 'customFieldID', 'customFieldId', 'ID', 'id',
  'EntityTypeID', 'entityTypeID', 'entityTypeId',
  'Value', 'value', 'MultiSelectValues', 'multiSelectValues',
];
function slimCustomFieldEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = {};
  for (const key of CUSTOM_FIELD_ENTRY_KEYS) if (entry[key] !== undefined && entry[key] !== null) out[key] = entry[key];
  return out;
}
function slimModule(m) {
  const { Tasks, tasks, CustomFields, customFields, ...rest } = m || {};
  if (Array.isArray(CustomFields)) rest.CustomFields = CustomFields.map(slimCustomFieldEntry);
  if (Array.isArray(customFields)) rest.customFields = customFields.map(slimCustomFieldEntry);
  return rest;
}

const PROJECT_ID_KEYS = ['ProjectID', 'projectID'];
const MODULE_ID_KEYS = ['ModuleID', 'moduleID'];

async function loadProjectsWithReport() {
  return pw.getAllWithReport('/api/v1/Projects', {}, { map: slimProject, idKeys: PROJECT_ID_KEYS, label: 'GET /api/v1/Projects' });
}

/** Projects, cached. A short read is never cached and never used: it throws. */
function getProjects({ force = false } = {}) {
  return cached('ref:projects', PROJECTS_CACHE_MS, async () => {
    const { rows, report } = await loadProjectsWithReport();
    if (!report.complete) {
      const err = new Error(`GET /api/v1/Projects is incomplete: fetched ${report.unique} of ${report.total}.`);
      err.report = report;
      throw err;
    }
    return rows;
  }, { force });
}

function getOffices() {
  return cached('ref:offices', REFERENCE_CACHE_MS, async () => {
    // /Offices takes no pageSize and returns no pagination headers.
    const rows = await pwGetAll('/api/v1/Offices', {}, { noPageSize: true, idKeys: ['OfficeID', 'officeID'] });
    return rows
      .map((o) => ({
        id: String(firstValue(o, ['OfficeID', 'officeID']) ?? ''),
        name: String(firstValue(o, ['Name', 'name']) || '').trim(),
        isActive: firstValue(o, ['IsActive', 'isActive']) !== false,
      }))
      .filter((o) => o.id && o.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

function collectionFromResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const keys = ['Users', 'users', 'Items', 'items', 'Data', 'data', 'Results', 'results', 'Records', 'records'];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === 'object') {
    for (const key of keys) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }
  return [payload];
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function loadModuleCustomFieldDefinitions() {
  let entityTypeID = MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID;
  let entityTypeSource = entityTypeID ? 'configured' : 'unresolved';
  let entityTypeIssue = '';

  if (!entityTypeID) {
    try {
      const types = await pwGet('/api/v1/CustomFields/EntityTypes');
      if (!Array.isArray(types)) throw new Error('returned a non-array response');
      const moduleType = types.find((type) => ['module', 'modules'].includes(
        String(firstValue(type, ['Name', 'name']) || '').trim().toLowerCase()
      ));
      if (moduleType) {
        entityTypeID = String(firstValue(moduleType, ['EntityTypeID', 'entityTypeID']) || '');
        entityTypeSource = entityTypeID ? 'discovered' : 'unresolved';
      } else {
        // Expected on SJB: stage (module) fields live under "Project Budget".
        // That type is named here but deliberately not adopted — scoping to it
        // switches on the ordinal fallback, which misplaces values. Fields are
        // matched by label instead.
        const budgetType = types.find((type) =>
          String(firstValue(type, ['Name', 'name']) || '').trim().toLowerCase() === 'project budget');
        const budgetTypeID = budgetType ? firstValue(budgetType, ['EntityTypeID', 'entityTypeID']) : undefined;
        entityTypeIssue = budgetType
          ? `Stage custom fields are defined on the "Project Budget" entity type (EntityTypeID ${budgetTypeID}); matching them by label.`
          : 'No "Module" or "Project Budget" custom-field entity type was returned; matching stage custom fields by label.';
      }
    } catch (err) {
      entityTypeIssue = `Module custom-field entity type could not be discovered: ${String(err.message || err)}`;
    }
  }

  const scope = entityTypeID ? { EntityTypeID: entityTypeID } : {};
  const fieldIDKeys = ['FieldID', 'fieldID'];
  const [rawDefinitions, ...labelGroups] = await Promise.all([
    pwGetAll('/api/v1/CustomFields', scope, { idKeys: fieldIDKeys }),
    ...MODULE_CUSTOM_FIELDS.map((field) => pwGetAll('/api/v1/CustomFields', { ...scope, Label: field.label }, { idKeys: fieldIDKeys })),
  ]);
  const definitions = rawDefinitions.map((definition) => ({
    ...definition,
    ...(entityTypeID ? { __entityTypeID: entityTypeID } : {}),
  }));
  const additions = [];

  MODULE_CUSTOM_FIELDS.forEach((field, groupIndex) => {
    for (const candidate of labelGroups[groupIndex]) {
      const candidateID = firstValue(candidate, ['FieldID', 'fieldID', 'fieldId', 'ID', 'id']);
      let matchingIndexes = [];
      if (candidateID !== undefined && candidateID !== null) {
        matchingIndexes = definitions
          .map((definition, index) => ({ definition, index }))
          .filter(({ definition }) => String(firstValue(definition, ['FieldID', 'fieldID', 'fieldId', 'ID', 'id'])) === String(candidateID))
          .map(({ index }) => index);
      }
      if (!matchingIndexes.length) {
        const signature = canonicalJSON(candidate);
        matchingIndexes = definitions
          .map((definition, index) => ({ definition, index }))
          .filter(({ definition }) => canonicalJSON(rawDefinitions[index]) === signature)
          .map(({ index }) => index);
      }

      if (matchingIndexes.length === 1) {
        definitions[matchingIndexes[0]].__configuredLabel = field.label;
      } else {
        // A labelled query result can still match a module value by field ID
        // even when the full definition collection did not expose enough
        // identity to locate its ordinal position.
        additions.push({
          ...candidate,
          __configuredLabel: field.label,
          ...(entityTypeID ? { __entityTypeID: entityTypeID } : {}),
        });
      }
    }
  });

  return {
    definitions: [...definitions, ...additions],
    entityTypeID,
    entityTypeSource,
    entityTypeIssue,
  };
}

// ---- tenant lock -----------------------------------------------------------
// The API host is identical for every tenant, production included — the tenant
// is decided solely by the credential. Nothing in the responses this app reads
// (Projects, Modules, Invoices, Forecasts, Users) names the tenant except the
// office carried on each project: OfficeName. That is the only tenant-owned
// identity available without adding an API call, so the lock is built on it.
//
// A brand new Projectworks tenant names its office "My Organisation", so that
// value identifies nothing — every unrenamed sandbox would satisfy a lock set
// to it. The lock therefore rejects the default outright: each sandbox must be
// given a distinctive office name in Projectworks before this app will run
// against it. That rename is what turns re-pointing at a new sandbox into a
// deliberate act.
const DEFAULT_OFFICE_NAMES = new Set(['my organisation', 'my organization']);

let RESOLVED_TENANT = null; // { name, names, offices } — set during boot, before listen

/** Case- and whitespace-insensitive form used for every tenant comparison. */
function normalizeTenantName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Letters and digits only — for the loose PW_APP_BASE_URL subdomain check. */
function alphanumeric(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The distinct office names this credential can see, sorted. Every project
 * page is checked because a multi-organisation tenant may not expose every
 * office on the first page.
 */
async function resolveTenantOfficeNames() {
  // Forced fresh at boot; a short read throws, so the lock never decides on a
  // partial project list. The result also warms the grid's project cache.
  const projects = await getProjects({ force: true });
  const names = new Set();
  for (const p of projects) {
    const name = String(firstValue(p, ['OfficeName', 'officeName']) || '').trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the tenant and require every office name returned on its projects to
 * be in PW_TENANT_LOCK. The lock is an allow-list rather than a required set:
 * an organisation with no returned projects cannot be discovered through this
 * endpoint. Fails closed on any unexpected office name.
 */
async function enforceTenantLock() {
  const defaultLockName = TENANT_LOCK_NAMES.find((name) => DEFAULT_OFFICE_NAMES.has(normalizeTenantName(name)));
  if (defaultLockName) {
    refuseToStart([
      `PW_TENANT_LOCK includes "${defaultLockName}", which is the default office name`,
      'Projectworks gives every new tenant. It identifies nothing: any other',
      'sandbox whose office has not been renamed would satisfy this lock too.',
      '',
      'Give this tenant a distinctive office name in Projectworks',
      '(Settings → Offices), then list the exact office name(s) in PW_TENANT_LOCK.',
    ]);
  }

  let offices;
  try {
    offices = await resolveTenantOfficeNames();
  } catch (err) {
    refuseToStart([
      'The Projectworks tenant could not be resolved, so the server cannot',
      'confirm which tenant this credential belongs to.',
      '',
      `  GET /api/v1/Projects failed: ${String(err.message || err)}`,
      '',
      `Expected tenant (PW_TENANT_LOCK): "${TENANT_LOCK}"`,
      'Refusing to start rather than assuming the tenant is correct.',
    ]);
  }

  if (!offices.length) {
    refuseToStart([
      'The Projectworks tenant could not be resolved: GET /api/v1/Projects',
      'returned no project carrying an OfficeName, so there is nothing to',
      'identify the tenant by.',
      '',
      `Expected tenant (PW_TENANT_LOCK): "${TENANT_LOCK}"`,
      'Refusing to start rather than assuming the tenant is correct.',
    ]);
  }

  if (offices.every((name) => DEFAULT_OFFICE_NAMES.has(normalizeTenantName(name)))) {
    refuseToStart([
      `This tenant's office is still named "${offices[0]}" — the Projectworks`,
      'default. It cannot be told apart from any other unrenamed tenant, so it',
      'cannot be locked to.',
      '',
      `Expected tenant (PW_TENANT_LOCK): "${TENANT_LOCK}"`,
      `Actual tenant:                    "${offices.join('", "')}"`,
      '',
      'Rename the office in Projectworks (Settings → Offices) to something',
      'unique to this sandbox, then set PW_TENANT_LOCK to that name.',
    ]);
  }

  const comparison = compareTenantOfficeNames(TENANT_LOCK_NAMES, offices);
  if (!comparison.matches) {
    refuseToStart([
      'TENANT MISMATCH — the credential returned an office outside the SJB allow-list.',
      '',
      `  Allowed (PW_TENANT_LOCK):  "${TENANT_LOCK}"`,
      `  Actual (from the API):     "${offices.join('", "')}"`,
      ...(comparison.unexpected.length ? [`  Unexpected office(s):       "${comparison.unexpected.join('", "')}"`] : []),
      '',
      `  API host: ${new URL(BASE_URL).host} (identical for every tenant, so it`,
      '            proves nothing on its own)',
      '',
      'The credential in PW_USERNAME / PW_PASSWORD or PW_AUTH_HEADER_VALUE',
      'belongs to a different tenant than the one this deployment is locked to.',
      'Either fix the credential, or — if re-pointing at this tenant is',
      'intended — update PW_TENANT_LOCK to the complete comma-separated allow-list.',
    ]);
  }

  return {
    name: comparison.matchedNames.join(' + '),
    names: comparison.matchedNames,
    offices,
  };
}

/**
 * PW_APP_BASE_URL drives the deep links out of the grid. Its subdomain is the
 * tenant's web app; if that does not look like the tenant the data came from,
 * every link in the UI points at a different tenant than the numbers. Warned
 * about loudly rather than fatal — the links are cosmetic, the data is not.
 */
function appBaseUrlTenantWarning(tenantNames) {
  if (!APP_BASE_URL) return null;

  let host;
  try {
    host = new URL(APP_BASE_URL).host;
  } catch {
    return [`PW_APP_BASE_URL is not a valid URL (${APP_BASE_URL}); deep links will be wrong.`];
  }

  const subdomain = host.split('.')[0] || '';
  const sub = alphanumeric(subdomain);
  const names = Array.isArray(tenantNames) ? tenantNames : [tenantNames];
  const tenants = names.map(alphanumeric).filter(Boolean);
  if (!sub || !tenants.length || tenants.some((tenant) => sub.includes(tenant) || tenant.includes(sub))) return null;

  return [
    'PW_APP_BASE_URL does not match the resolved tenant.',
    '',
    `  Resolved tenant: ${names.join(' + ')}`,
    `  Deep-link host:  ${host}  (subdomain "${subdomain}")`,
    '',
    'Deep links from the grid open a DIFFERENT tenant than the data shown.',
    'Fix PW_APP_BASE_URL, or clear it to render plain text instead of links.',
  ];
}

function warnBanner(lines) {
  const width = Math.max(60, ...lines.map((l) => l.length)) + 4;
  const bar = '*'.repeat(width + 1);
  console.warn('');
  console.warn(`  ${bar}`);
  console.warn(`  *  WARNING:${' '.repeat(width - 11)}*`);
  for (const line of lines) console.warn(`  *  ${line}${' '.repeat(width - 3 - line.length)}*`);
  console.warn(`  ${bar}`);
  console.warn('');
}

function firstField(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function normalizeProjectworksUser(raw) {
  const id = firstField(raw, ['userID', 'UserID', 'id', 'ID', 'userId', 'UserId']);
  if (id === '') return null;
  const email = firstField(raw, ['email', 'Email', 'emailAddress', 'EmailAddress', 'loginEmail', 'LoginEmail']);
  const firstName = firstField(raw, ['firstName', 'FirstName', 'givenName', 'GivenName']);
  const lastName = firstField(raw, ['lastName', 'LastName', 'surname', 'Surname', 'familyName', 'FamilyName']);
  const fullName = firstField(raw, [
    'displayName', 'DisplayName',
    'name', 'Name',
    'fullName', 'FullName',
    'userName', 'UserName',
  ]);
  const name = String(fullName || [firstName, lastName].filter(Boolean).join(' ') || email || `User ${id}`).trim();
  return {
    id: String(id),
    name,
    ...(email ? { email: String(email).trim() } : {}),
  };
}

function cacheUsers(users) {
  usersCache = {
    at: Date.now(),
    users,
    byID: new Map(users.map((u) => [String(u.id), u])),
  };
}

async function fetchProjectworksUsers(params = {}) {
  const payload = await pwGet('/api/v1/Users', params);
  return collectionFromResponse(payload);
}

async function getProjectworksUsers(force = false) {
  if (!force && usersCache.users.length && Date.now() - usersCache.at < USER_CACHE_MS) {
    return usersCache.users;
  }
  const out = await pwGetAll('/api/v1/Users', {}, { pageSize: USER_PAGE_SIZE, idKeys: ['UserID', 'userID'] });
  const users = out
    .map(normalizeProjectworksUser)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  cacheUsers(users);
  return users;
}

async function getProjectworksUserByID(id) {
  const wanted = String(id || '').trim();
  if (!wanted) return null;
  await getProjectworksUsers(false);
  let user = usersCache.byID.get(wanted);
  if (user) return user;

  let direct = [];
  try {
    direct = (await fetchProjectworksUsers({ UserID: wanted, page: 1, pageSize: USER_PAGE_SIZE }))
      .map(normalizeProjectworksUser)
      .filter(Boolean);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return null;
    throw err;
  }
  user = direct.find((u) => String(u.id) === wanted) || direct[0] || null;
  if (user) cacheUsers([...usersCache.users.filter((u) => String(u.id) !== String(user.id)), user]);
  return user;
}

// ---- module lookup (IsServices) -------------------------------------------
// IsServices is the single field that separates the two tabs — and the two
// kinds of number. The UI splits on it (Gross fees = services), so the server
// guard must use exactly the same field or the two can disagree about which
// modules are allowed to reach Projectworks.
const MODULE_CACHE_MS = 5 * 60 * 1000;
let modulesCache = { at: 0, byID: new Map() };

function cacheModules(modules, at = Date.now()) {
  if (at < modulesCache.at) return;
  modulesCache = {
    at,
    byID: new Map(modules.map((m) => [String(firstValue(m, MODULE_ID_KEYS)), m])),
  };
}

async function getModuleByID(id) {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const fresh = Date.now() - modulesCache.at < MODULE_CACHE_MS;
  const hit = fresh ? modulesCache.byID.get(wanted) : null;
  if (hit) return hit;
  // One targeted read rather than re-paging all ~28,000 modules for a single
  // write. The result is checked by ID, so an ignored filter cannot pass off
  // some other module.
  const rows = await pwGetAll('/api/v1/Modules', { ModuleID: wanted }, { idKeys: MODULE_ID_KEYS });
  const module = rows.find((m) => String(firstValue(m, MODULE_ID_KEYS)) === wanted) || null;
  if (module) modulesCache.byID.set(wanted, slimModule(module));
  return module;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * The gate on every write to Projectworks Forecasts. Consultant (non-services)
 * modules carry subconsultant costs, which are planning numbers held in this
 * app and must never be posted to a screen that represents money coming in.
 *
 * Fails closed: a module that cannot be resolved — unknown id, or the Modules
 * call failing — is refused, never assumed to be services.
 */
async function assertServicesModule(moduleID) {
  let module;
  try {
    module = await getModuleByID(moduleID);
  } catch (err) {
    throw httpError(502, `Module ${moduleID} could not be checked against Projectworks, so nothing was written: ${String(err.message || err)}`);
  }
  if (!module) {
    throw httpError(400, `Module ${moduleID} was not found in Projectworks, so nothing was written.`);
  }
  if (!firstValue(module, ['IsServices', 'isServices'])) {
    throw httpError(
      403,
      `Module ${moduleID} is a consultant (non-services) module. Subconsultant fees are ` +
      'planning numbers held in this app and are never written to Projectworks. ' +
      'Edit them on the supplier lines of the Consultant fees tab.'
    );
  }
  return module;
}

async function assertConsultantModule(moduleID) {
  let module;
  try {
    module = await getModuleByID(moduleID);
  } catch (err) {
    throw httpError(502, `Module ${moduleID} could not be checked against Projectworks, so nothing was saved: ${String(err.message || err)}`);
  }
  if (!module) throw httpError(400, `Module ${moduleID} was not found in Projectworks, so nothing was saved.`);
  if (firstValue(module, ['IsServices', 'isServices'])) {
    throw httpError(403, `Module ${moduleID} is a services module. Supplier planning lines may only be attached to consultant modules.`);
  }
  return module;
}

async function supplierLineForWrite(id) {
  const line = (await storage.getSupplierLines()).find((candidate) => candidate.id === id);
  if (!line) throw httpError(404, `supplier line ${id} not found`);
  await assertConsultantModule(line.moduleID);
  return line;
}

async function resolveSelectedAuditUser(body) {
  const selectedProjectworksUserID = String(body?.selectedProjectworksUserID || '').trim();
  if (!selectedProjectworksUserID) {
    throw httpError(400, 'Select a user before editing.');
  }
  const user = await getProjectworksUserByID(selectedProjectworksUserID);
  if (!user) {
    throw httpError(400, 'Selected Projectworks user was not found.');
  }
  return user;
}

function sendUserResolveError(res, err) {
  res.status(err.status || 502).json({ error: String(err.message || err) });
}

function sendStoreError(res, err, note) {
  console.error(err);
  return res.status(err.status || 500).json({
    error: String((err && err.message) || err) + (note ? ` ${note}` : ''),
  });
}

/**
 * POST /api/v1/Forecasts/Set for one module-month. Returns { ok, error }.
 * `comment` lands in the forecast change history in the Projectworks UI;
 * the Open API only writes it (GET /Forecasts never returns it).
 *
 * SERVICES MODULES ONLY. This is the app's single write into Projectworks and
 * it must keep exactly one caller — the /api/forecast route, which refuses
 * anything that is not IsServices. Consultant fees never come through here.
 */
async function pwSetForecast(moduleID, month, amount, comment) {
  try {
    const r = await fetch(new URL(BASE_URL + '/api/v1/Forecasts/Set'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders() },
      signal: AbortSignal.timeout(PW_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        moduleID,
        date: `${month}-01`,
        amount: Number(amount),
        comment: comment ? String(comment) : null,
      }),
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) return { ok: false, error: `Forecasts/Set → ${r.status} ${r.statusText} ${text.slice(0, 300)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function pwForecastAmount(moduleID, month) {
  const forecasts = await pwGetAll('/api/v1/Forecasts', {
    ModuleID: moduleID,
    StartDate: `${month}-01`,
    EndDate: monthEndDate(month),
  });
  const monthly = aggregateForecasts(forecasts).get(String(moduleID)) || {};
  return Object.prototype.hasOwnProperty.call(monthly, month) ? monthly[month] : 0;
}

function monthKey(dateStr) {
  // Forecast/invoice dates arrive as ISO strings; bucket to YYYY-MM.
  return String(dateStr).slice(0, 7);
}

function monthEndDate(month) {
  const [year, monthNumber] = String(month).split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

// ---- grid snapshots and background refresh ---------------------------------
// The grid is served from the last good snapshot of its sources, held in
// memory and gzipped in Postgres so a restart or deploy does not lose it. Only
// ACTIVE projects are in a snapshot: archived projects (IsActive=false, or an
// ARCHIVED_PROJECT_STATUSES status) are dropped as soon as the project list is
// read, and their modules are never requested.
//
// "Load data" refreshes in the background; the previous snapshot stays on
// screen until the new one is installed. Modules are read one project at a
// time (fetchModulesByProject). After the first full sync, a refresh reads
// only the modules changed since the previous one (ModifiedSinceDate) and
// re-reads in full just the projects whose listed modules no longer match the
// cache; a full sync runs again every FULL_SYNC_INTERVAL_HOURS.
//
// A refresh that cannot read everything never replaces a good snapshot: a
// project whose read failed keeps its modules from the previous snapshot, and
// a refresh still incomplete after that is logged and discarded when the
// window already has a snapshot. Nothing about completeness reaches the UI.
//
// Writes keep snapshots honest. A forecast write is patched into every
// in-memory snapshot whose window holds that month and into any refresh in
// flight; a stored-only snapshot for such a window is dropped. Supplier lines
// are read from Postgres on every build, so they are never stale.
const SNAPSHOTS_IN_MEMORY = 2;
const SNAPSHOT_PERSIST_DELAY_MS = 2000;
const FORECAST_PATCH_RETENTION_MS = 60 * 60 * 1000;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const snapshots = new Map();      // windowKey -> sources, least recently used first
const snapshotLoads = new Map();  // windowKey -> in-flight Postgres restore
const refreshJobs = new Map();    // windowKey -> latest refresh job, running or finished
const persistTimers = new Map();  // windowKey -> debounce timer
const persistChains = new Map();  // windowKey -> last save, so saves never overlap
let forecastPatches = [];         // { at, moduleID, month, entries }, newest last
let sourceDiagnosticsLogged = false;

const windowKeyOf = (startMonth, endMonth) => `${startMonth}:${endMonth}`;
function windowHolds(windowKey, month) {
  const [startMonth, endMonth] = windowKey.split(':');
  return month >= startMonth && month <= endMonth; // 'YYYY-MM' sorts lexically
}

const REFRESH_PHASES = ['projects', 'reference', 'modules', 'invoices', 'expenses', 'forecasts', 'build'];

function createRefreshJob(windowKey) {
  const phases = Object.fromEntries(REFRESH_PHASES.map((name) => [name, { status: 'pending' }]));
  return {
    windowKey,
    status: 'running',
    mode: null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    phases,
    phase(name, status, ms) { Object.assign(phases[name], { status }, ms === undefined ? {} : { ms }); },
    progress(name, value) { Object.assign(phases[name], value); },
  };
}

/** What the UI may see of a refresh: its state and progress, never an error message. */
function refreshStatus(job) {
  if (!job) return { status: 'idle' };
  return {
    status: job.status === 'error' ? 'done' : job.status,
    mode: job.mode,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    phases: job.phases,
  };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const count = (n) => Number(n || 0).toLocaleString('en-US');
const idOf = (record, keys) => String(firstValue(record, keys));

/** The newest snapshot of any window, as the base for an incremental refresh. */
async function latestSnapshot() {
  let newest = null;
  for (const sources of snapshots.values()) if (!newest || sources.fetchedAt > newest.fetchedAt) newest = sources;
  if (newest) return newest;
  try {
    const [windowKey] = await storage.listGridSnapshots();
    return windowKey ? await getSnapshot(windowKey) : null;
  } catch (err) {
    console.error(`stored grid snapshots could not be listed: ${String(err.message || err)}`);
    return null;
  }
}

/**
 * One read of every grid source, timed per phase. Resolves to the sources
 * with `complete` and `incomplete` (reasons, for the log); it rejects only
 * when a source could not be read at all.
 */
async function fetchGridSources(startMonth, endMonth, job, { full = false } = {}) {
  const started = Date.now();
  // Consultant Fees to Date is actual pre-tax expense spend through today.
  const asOfDate = new Date().toISOString().slice(0, 10);
  const timings = {};
  const incomplete = [];
  const phase = async (name, work) => {
    const t = Date.now();
    job.phase(name, 'running');
    try {
      return await work();
    } finally {
      timings[name] = Date.now() - t;
      job.phase(name, 'done', timings[name]);
    }
  };
  const collect = (name, pathname, params, opts) => phase(name, () => pw.getAllWithReport(pathname, params, {
    label: `GET ${pathname}`,
    onProgress: ({ pagesDone, pages }) => job.progress(name, { pagesDone, pages }),
    ...opts,
  }));

  // The previous snapshot of this window is the fallback for anything this
  // read cannot complete; the newest snapshot of any window is the base for
  // an incremental module read.
  const previous = await getSnapshot(windowKeyOf(startMonth, endMonth));
  const base = full ? null : (previous && previous.sync ? previous : await latestSnapshot());
  const incremental = !!(base && base.sync && Date.now() - base.sync.fullSyncedAt < FULL_SYNC_INTERVAL_MS);
  job.mode = incremental ? 'incremental' : 'full';

  const work = {
    projects: phase('projects', async () => {
      const all = await getProjects({ force: true });
      const active = all.filter((project) => !isArchivedProject(project, ARCHIVED_PROJECT_STATUSES));
      return { all: all.length, active };
    }),
    reference: phase('reference', () => Promise.all([
      getOffices(),
      cached('ref:customFields', REFERENCE_CACHE_MS, loadModuleCustomFieldDefinitions),
    ])),
    invoices: collect('invoices', '/api/v1/Invoices', {}, { idKeys: ['InvoiceID', 'invoiceID'] }),
    expenses: collect('expenses', '/api/v1/ExpenseClaims', { EndDate: `${asOfDate}T23:59:59.999Z`, IncludeCustomFields: false },
      { idKeys: ['ExpenseClaimID', 'expenseClaimID'] }),
    forecasts: collect('forecasts', '/api/v1/Forecasts', { StartDate: `${startMonth}-01`, EndDate: monthEndDate(endMonth) },
      { idKeys: ['ForecastID', 'forecastID'] }),
  };
  work.modules = phase('modules', async () => {
    const { active } = await work.projects;
    return readActiveModules(active, incremental ? base : null, previous || base, job);
  });
  // Every phase is awaited below, but not at the same moment: an early failure
  // in one must not leave a later rejection in another unhandled.
  for (const promise of Object.values(work)) promise.catch(() => {});

  const { all: projectsTotal, active: projects } = await work.projects;
  const moduleRead = await work.modules;
  if (moduleRead.unrecovered.length) {
    incomplete.push(`modules missing on ${moduleRead.unrecovered.length} active project(s) ` +
      `(ProjectID ${moduleRead.unrecovered.map((f) => f.projectID).join(', ')})`);
  }
  const [[offices, customFieldConfig], invoicesRead, expensesRead, forecastsRead] =
    await Promise.all([work.reference, work.invoices, work.expenses, work.forecasts]);

  // Keep only what belongs to an active project. A collection that did not
  // match its x-total-count falls back to the previous snapshot's copy.
  const activeProjectIDs = new Set(projects.map((p) => idOf(p, PROJECT_ID_KEYS)));
  const activeModuleIDs = new Set(moduleRead.modules.map((m) => idOf(m, MODULE_ID_KEYS)));
  const settle = (name, read, keep, fallback) => {
    if (read.report.complete) return read.rows.filter(keep);
    const short = `${read.report.label}: fetched ${count(read.report.unique)} of ${count(read.report.total)}`;
    if (fallback) {
      console.warn(`grid refresh: ${short}; keeping the previous snapshot's ${name}`);
      return fallback.filter(keep);
    }
    incomplete.push(short);
    return read.rows.filter(keep);
  };
  const invoices = settle('invoices', invoicesRead,
    (inv) => activeProjectIDs.has(idOf(inv, PROJECT_ID_KEYS)), previous && previous.invoices);
  const expenseClaims = settle('expense claims', expensesRead,
    (claim) => activeModuleIDs.has(idOf(claim, MODULE_ID_KEYS)), previous && previous.expenseClaims);
  const forecasts = settle('forecasts', forecastsRead,
    (f) => activeModuleIDs.has(idOf(f, MODULE_ID_KEYS)), previous && previous.forecasts);

  const fetchMs = Date.now() - started;
  return {
    version: 2,
    startMonth,
    endMonth,
    projects,
    projectsTotal,
    offices,
    customFieldConfig,
    modules: moduleRead.modules,
    invoices,
    forecasts,
    expenseClaims,
    asOfDate,
    complete: incomplete.length === 0,
    incomplete,
    sync: {
      mode: job.mode,
      syncedAt: started,
      fullSyncedAt: incremental ? base.sync.fullSyncedAt : started,
    },
    moduleRead: moduleRead.summary,
    counts: {
      invoicesRead: invoicesRead.rows.length,
      expensesRead: expensesRead.rows.length,
      forecastsRead: forecastsRead.rows.length,
    },
    timings: { ...timings, total: fetchMs },
    fetchMs,
    fetchedAt: Date.now(),
  };
}

/**
 * The modules of every active project. Full: one read per project. With an
 * incremental base: the modules changed since its sync, applied to its
 * modules, plus a full read of each project whose listed modules no longer
 * match. A project whose read fails keeps its modules from `fallback`.
 */
async function readActiveModules(projects, base, fallback, job) {
  let carried = [];
  let toRead = projects;
  const summary = { mode: base ? 'incremental' : 'full', changed: 0, removed: 0 };
  if (base) {
    const since = new Date(base.sync.syncedAt - MODIFIED_SINCE_OVERLAP_MS).toISOString();
    const changed = await pw.getAllWithReport('/api/v1/Modules', { ModifiedSinceDate: since, IncludeCustomFields: true },
      { map: slimModule, idKeys: MODULE_ID_KEYS, label: `GET /api/v1/Modules?ModifiedSinceDate=${since}` });
    if (changed.report.complete) {
      const merge = mergeModuleChanges({
        projects,
        previousProjectIDs: base.projects.map((p) => idOf(p, PROJECT_ID_KEYS)),
        previousModules: base.modules,
        changedModules: changed.rows,
      });
      const refetch = new Set(merge.toFetch);
      carried = merge.modules;
      toRead = projects.filter((p) => refetch.has(idOf(p, PROJECT_ID_KEYS)));
      Object.assign(summary, { changed: changed.rows.length, removed: merge.removed });
    } else {
      // More than a page of changes, read over the unstable sort: start over.
      console.warn(`grid refresh: ${changed.report.label} fetched ${changed.report.unique} of ${changed.report.total}; running a full module sync`);
      summary.mode = 'full';
      job.mode = 'full';
    }
  }

  let retried = 0;
  const read = await fetchModulesByProject({
    projects: toRead,
    concurrency: MODULE_FETCH_CONCURRENCY,
    fetchProjectModules: (projectID) => pw.getAllWithReport('/api/v1/Modules', { ProjectID: projectID, IncludeCustomFields: true },
      { map: slimModule, idKeys: MODULE_ID_KEYS, label: `GET /api/v1/Modules?ProjectID=${projectID}` }),
    onProgress: ({ done, total }) => job.progress('modules', { projectsDone: done, projects: total }),
    onRetry: ({ projectID, attempt, reason }) => {
      retried += 1;
      console.warn(`grid refresh: modules of ProjectID ${projectID} re-read (attempt ${attempt + 1}): ${reason}`);
    },
  });

  const unrecovered = [];
  const kept = [];
  if (read.failed.length) {
    const previousByProject = new Map();
    for (const m of (fallback && fallback.modules) || []) {
      const key = idOf(m, PROJECT_ID_KEYS);
      if (!previousByProject.has(key)) previousByProject.set(key, []);
      previousByProject.get(key).push(m);
    }
    for (const failure of read.failed) {
      const cachedModules = previousByProject.get(failure.projectID);
      console.warn(`grid refresh: modules of ProjectID ${failure.projectID} could not be read: ${failure.reason}` +
        `${cachedModules ? `; keeping ${cachedModules.length} from the previous snapshot` : ''}`);
      // With nothing cached (a first sync), the partial read is shown rather than nothing.
      if (cachedModules) kept.push(...cachedModules);
      else {
        kept.push(...failure.partial);
        unrecovered.push(failure);
      }
    }
  }
  Object.assign(summary, {
    projectsRead: toRead.length,
    retried,
    failed: read.failed.length,
    keptFromCache: read.failed.length - unrecovered.length,
  });
  return { modules: [...carried, ...read.modules, ...kept], unrecovered, summary };
}

function patchForecasts(sources, { moduleID, month, entries }) {
  const sameCell = (forecast) => String(firstValue(forecast, MODULE_ID_KEYS)) === String(moduleID) &&
    String(firstValue(forecast, ['Date', 'date']) || '').slice(0, 7) === month;
  sources.forecasts = sources.forecasts.filter((forecast) => !sameCell(forecast)).concat(entries);
}

/** Re-apply the forecast writes made since `since` to a snapshot read before them. */
function applyForecastPatches(sources, since) {
  const windowKey = windowKeyOf(sources.startMonth, sources.endMonth);
  for (const patch of forecastPatches) {
    if (patch.at >= since && windowHolds(windowKey, patch.month)) patchForecasts(sources, patch);
  }
}

/**
 * A forecast cell was written to Projectworks. Forecasts/Set replaces the
 * module-month, so the cell's value is now exactly `amount`; every snapshot
 * that shows it is patched rather than re-read.
 */
async function recordForecastWrite(moduleID, projectID, month, amount) {
  const now = Date.now();
  const patch = {
    at: now,
    moduleID,
    month,
    entries: [{ ModuleID: moduleID, ProjectID: projectID, Date: `${month}-01T00:00:00`, Amount: amount }],
  };
  forecastPatches = forecastPatches.filter((p) => p.at > now - FORECAST_PATCH_RETENTION_MS).slice(-4999);
  forecastPatches.push(patch);
  for (const [windowKey, sources] of snapshots) {
    if (!windowHolds(windowKey, month)) continue;
    patchForecasts(sources, patch);
    schedulePersist(windowKey, sources);
  }
  // A window held only in Postgres is dropped rather than patched; the next
  // load of it refreshes from Projectworks.
  try {
    for (const windowKey of await storage.listGridSnapshots()) {
      if (!snapshots.has(windowKey) && windowHolds(windowKey, month)) await storage.deleteGridSnapshot(windowKey);
    }
  } catch (err) {
    console.error(`Stored grid snapshots could not be invalidated after a forecast write: ${String(err.message || err)}`);
  }
}

function installSnapshot(windowKey, sources) {
  snapshots.delete(windowKey);
  snapshots.set(windowKey, sources);
  while (snapshots.size > SNAPSHOTS_IN_MEMORY) snapshots.delete(snapshots.keys().next().value);
  // Keeps the IsServices guard on /api/forecast warm; it re-checks a module
  // directly once the snapshot is older than MODULE_CACHE_MS.
  cacheModules(sources.modules, sources.fetchedAt);
}

async function persistSnapshot(windowKey, sources) {
  const started = Date.now();
  try {
    const payload = await gzip(Buffer.from(JSON.stringify(sources)));
    await storage.saveGridSnapshot(windowKey, new Date(sources.fetchedAt), payload);
    console.log(`grid snapshot ${windowKey} saved to Postgres (${(payload.length / 1048576).toFixed(1)} MB gzipped) in ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`grid snapshot ${windowKey} could not be saved: ${String(err.message || err)}`);
  }
}

function schedulePersist(windowKey, sources, delayMs = SNAPSHOT_PERSIST_DELAY_MS) {
  clearTimeout(persistTimers.get(windowKey));
  persistTimers.set(windowKey, setTimeout(() => {
    persistTimers.delete(windowKey);
    const previous = persistChains.get(windowKey) || Promise.resolve();
    persistChains.set(windowKey, previous.then(() => persistSnapshot(windowKey, sources)));
  }, delayMs));
}

/** The window's snapshot from memory, else restored from Postgres, else null. */
function getSnapshot(windowKey) {
  const hit = snapshots.get(windowKey);
  if (hit) {
    snapshots.delete(windowKey);
    snapshots.set(windowKey, hit);
    return Promise.resolve(hit);
  }
  if (!snapshotLoads.has(windowKey)) {
    const load = (async () => {
      const started = Date.now();
      try {
        const stored = await storage.loadGridSnapshot(windowKey);
        if (!stored) return null;
        const sources = JSON.parse((await gunzip(stored.payload)).toString('utf8'));
        // A refresh may have installed a newer snapshot while this one was read.
        const current = snapshots.get(windowKey);
        if (current && current.fetchedAt >= sources.fetchedAt) return current;
        applyForecastPatches(sources, sources.fetchedAt);
        installSnapshot(windowKey, sources);
        console.log(`grid snapshot ${windowKey} restored from Postgres (fetched ${new Date(sources.fetchedAt).toISOString()}) in ${Date.now() - started}ms`);
        return sources;
      } catch (err) {
        console.error(`grid snapshot ${windowKey} could not be restored: ${String(err.message || err)}`);
        return null;
      } finally {
        snapshotLoads.delete(windowKey);
      }
    })();
    snapshotLoads.set(windowKey, load);
  }
  return snapshotLoads.get(windowKey);
}

/**
 * Start the background refresh of one window, or join the one already
 * running. job.promise resolves to the sources now being served for the
 * window (the new ones, or the previous ones when this read was incomplete),
 * or null when there are none; it never rejects. Failures are logged here and
 * nowhere else.
 */
function startRefresh(startMonth, endMonth, { full = false } = {}) {
  const windowKey = windowKeyOf(startMonth, endMonth);
  const running = refreshJobs.get(windowKey);
  if (running && running.status === 'running') return running;
  const job = createRefreshJob(windowKey);
  refreshJobs.set(windowKey, job);
  const finish = (status) => {
    job.status = status;
    job.finishedAt = Date.now();
  };
  job.promise = (async () => {
    const sources = await fetchGridSources(startMonth, endMonth, job, { full });
    applyForecastPatches(sources, job.startedAt);

    // Build once: times the build phase and proves the snapshot renders.
    const buildStarted = Date.now();
    job.phase('build', 'running');
    await buildGrid(sources, { logDiagnostics: true });
    sources.timings.build = Date.now() - buildStarted;
    job.phase('build', 'done', sources.timings.build);
    logRefresh(sources, job);

    const current = await getSnapshot(windowKey);
    if (!sources.complete && current) {
      for (const reason of sources.incomplete) console.error(`grid refresh ${startMonth}..${endMonth} incomplete: ${reason}`);
      console.error(`grid refresh ${startMonth}..${endMonth}: kept the previous snapshot (fetched ${new Date(current.fetchedAt).toISOString()})`);
      finish('done');
      return current;
    }
    for (const reason of sources.incomplete) {
      console.error(`grid refresh ${startMonth}..${endMonth} incomplete, installed (no previous snapshot): ${reason}`);
    }
    installSnapshot(windowKey, sources);
    schedulePersist(windowKey, sources, 0);
    finish('done');
    if (!sourceDiagnosticsLogged) {
      sourceDiagnosticsLogged = true;
      logSourceDiagnostics(sources);
    }
    return sources;
  })().catch(async (err) => {
    job.error = String((err && err.message) || err);
    finish('error');
    console.error(`grid refresh ${startMonth}..${endMonth} failed after ${seconds(job.finishedAt - job.startedAt)}: ${job.error}`);
    return getSnapshot(windowKey);
  });
  return job;
}

/** One line per refresh: every phase's time and what it read. */
function logRefresh(sources, job) {
  const { timings, moduleRead: mr, counts: c } = sources;
  console.log(
    `grid refresh ${sources.startMonth}..${sources.endMonth} (${job.mode}) in ${seconds(Date.now() - job.startedAt)}: ` +
    `projects ${seconds(timings.projects)} (${count(sources.projects.length)} active of ${count(sources.projectsTotal)}) · ` +
    `reference ${seconds(timings.reference)} · ` +
    `modules ${seconds(timings.modules)} (${count(sources.modules.length)} stages; ${count(mr.projectsRead)} project(s) read` +
    `${mr.mode === 'incremental' ? `, ${count(mr.changed)} changed, ${count(mr.removed)} removed` : ''}` +
    `${mr.retried ? `, ${count(mr.retried)} re-read` : ''}${mr.failed ? `, ${count(mr.failed)} failed (${count(mr.keptFromCache)} kept from cache)` : ''}) · ` +
    `invoices ${seconds(timings.invoices)} (${count(sources.invoices.length)} of ${count(c.invoicesRead)} on active projects) · ` +
    `expenses ${seconds(timings.expenses)} (${count(sources.expenseClaims.length)} of ${count(c.expensesRead)}) · ` +
    `forecasts ${seconds(timings.forecasts)} (${count(sources.forecasts.length)} of ${count(c.forecastsRead)}) · ` +
    `build ${seconds(timings.build)}`
  );
}

/**
 * Operator diagnostics, logged once per process after the first refresh (no
 * API calls of their own). Nothing here reaches the UI: these are settings an
 * operator corrects in the environment.
 *
 *   - each MODULE_CUSTOM_FIELD_LABELS label: on how many stages it was found
 *   - invoices fetched, their distinct statuses, and how many match
 *     INVOICE_STATUS_CODES
 */
function logSourceDiagnostics({ customFieldConfig, modules, invoices, invoicesNote = '' }) {
  const found = new Map(MODULE_CUSTOM_FIELDS.map((field) => [field.key, 0]));
  for (const m of modules) {
    const custom = resolveModuleCustomFields(m, customFieldConfig.definitions, MODULE_CUSTOM_FIELDS, customFieldConfig.entityTypeID);
    for (const key of custom.matched) found.set(key, found.get(key) + 1);
  }
  console.log(`  Custom fields (${modules.length} stages):`);
  for (const field of MODULE_CUSTOM_FIELDS) {
    const n = found.get(field.key);
    const line = `    "${field.label}": ${n ? `returned on ${n} stages` : 'NOT FOUND on any stage — column will be blank'}`;
    if (n) console.log(line); else console.warn(line);
  }
  if (customFieldConfig.entityTypeIssue) console.log(`    ${customFieldConfig.entityTypeIssue}`);

  // SJB has no invoices until its data migration, so $0 Fees to Date is
  // expected for now; this line confirms the status match once they arrive.
  const summary = summarizeInvoiceStatuses(invoices, STATUS_CODES);
  console.log(
    `  Invoices:  ${summary.total} fetched${invoicesNote}; ` +
    `statuses seen: ${summary.statuses.map(([status, n]) => `${status} ×${n}`).join(', ') || 'none'}; ` +
    `${summary.matched} match INVOICE_STATUS_CODES`
  );
}

/**
 * Build the composed grid: one row per module (stage).
 *
 * Snapshots hold active projects only; archived projects (IsActive=false, or
 * an ARCHIVED_PROJECT_STATUSES status) are dropped here as well, so a snapshot
 * stored by an earlier build can never show one. Projects outside the selected
 * organisation are dropped before any aggregation, custom-field resolution or
 * serialisation — the browser never receives them.
 *
 * Configuration problems found while building are logged when
 * options.logDiagnostics is set (once per refresh), never sent to the UI.
 */
async function buildGrid(sources, options = {}) {
  const { startMonth, endMonth } = sources;
  const officeID = options.officeID ? String(options.officeID) : '';
  const fromSnapshot = !!options.fromSnapshot;
  const buildStarted = Date.now();
  const { offices, customFieldConfig, invoices, forecasts, expenseClaims, asOfDate } = sources;
  const customFieldDefinitions = customFieldConfig.definitions;
  const supplierLines = await storage.getSupplierLines();

  const projects = sources.projects.filter((project) =>
    !isArchivedProject(project, ARCHIVED_PROJECT_STATUSES) &&
    (!officeID || String(firstValue(project, ['OfficeID', 'officeID'])) === officeID));
  const projectById = new Map(projects.map((project) => [String(firstValue(project, PROJECT_ID_KEYS)), project]));
  // A module whose project is not in the (filtered) project list is dropped
  // too: an unknown project cannot be shown to be active or in the office.
  const modules = sources.modules.filter((m) => projectById.has(String(firstValue(m, PROJECT_ID_KEYS))));

  // Aggregations still read every module so the project/currency lookups for
  // expense validation stay complete; only kept modules become rows.
  const moduleProject = new Map(sources.modules.map((module) => [
    String(firstValue(module, MODULE_ID_KEYS)),
    String(firstValue(module, PROJECT_ID_KEYS)),
  ]));
  const projectCurrency = new Map(sources.projects.map((project) => [
    String(firstValue(project, PROJECT_ID_KEYS)),
    firstValue(project, ['CurrencyID', 'currencyID']),
  ]));
  const inWindow = (m) => m >= startMonth && m <= endMonth; // 'YYYY-MM' sorts lexically

  const invoiceActuals = aggregateInvoiceFees(invoices, STATUS_CODES);
  const expenseActuals = aggregateExpenseActuals(expenseClaims, {
    statusFilter: EXPENSE_STATUS_FILTER,
    moduleProject,
    projectCurrency,
    asOfDate,
  });
  const forecastByModule = aggregateForecasts(forecasts);
  const customFieldsMatched = new Set();
  let usedOrdinalCustomFieldMapping = false;

  const rows = modules.map((m) => {
    const moduleIDValue = firstValue(m, ['ModuleID', 'moduleID']);
    const moduleID = Number(moduleIDValue);
    const moduleKey = String(moduleIDValue);
    const projectIDValue = firstValue(m, ['ProjectID', 'projectID']);
    const projectKey = String(projectIDValue);
    const p = projectById.get(projectKey) || {};
    const fee = Number(firstValue(m, ['Budget', 'budget'])) || 0;
    const isServices = !!firstValue(m, ['IsServices', 'isServices']);
    const actual = isServices
      ? (invoiceActuals.totalsByModule.get(moduleKey) || 0)
      : (expenseActuals.totalsByModule.get(moduleKey) || 0);
    const custom = resolveModuleCustomFields(
      m,
      customFieldDefinitions,
      MODULE_CUSTOM_FIELDS,
      customFieldConfig.entityTypeID
    );
    for (const key of custom.matched) customFieldsMatched.add(key);
    if (custom.usedOrdinal) usedOrdinalCustomFieldMapping = true;
    // Two kinds of number, two sources. Services modules (Gross fees) show what
    // the customer plans to invoice, and Projectworks Forecasts is the field of
    // record. Non-services modules (Consultant fees) show subconsultant costs,
    // which live only in this app — reading them back from Projectworks would
    // return whatever the retired rollup last wrote and drift from the supplier
    // lines from the first edit onwards.
    const months = isServices
      ? (forecastByModule.get(moduleKey) || {})
      : moduleMonthTotals(supplierLines, moduleID, inWindow);
    const currencyIssue = expenseActuals.currencyIssuesByModule.get(moduleKey);
    return {
      moduleID,
      stat: firstValue(m, ['IsActive', 'isActive']) ? 'A' : 'I',
      isActive: !!firstValue(m, ['IsActive', 'isActive']),
      isServices,
      parentNumber: firstValue(p, ['ProjectNumber', 'projectNumber']) || '',
      projectID: Number(projectIDValue),
      projectName: firstValue(p, ['ProjectName', 'projectName']) || firstValue(m, ['Projectname', 'projectname']) || '',
      projectManagerName: firstValue(p, ['ProjectManagerName', 'projectManagerName']) || '',
      // Approximates BQE/Deltek's "Class" filter — not a literal field match.
      // Confirm against SJB's real tenant once migrated; Principal and
      // Originator have no Projectworks equivalent at all and are likely
      // tenant-specific custom fields, so they are not surfaced here.
      projectType: firstValue(p, ['ProjectTypeName', 'projectTypeName']) || '',
      officeID: firstValue(p, ['OfficeID', 'officeID']) ?? '',
      officeName: firstValue(p, ['OfficeName', 'officeName']) || '',
      stageName: firstValue(m, ['ModuleName', 'moduleName']) || '',
      stageNumber: custom.values.stageNumber || '',
      riskStatus: custom.values.riskStatus || '',
      fixedHourly: custom.values.fixedHourly || '',
      glCodeTypeName: firstValue(m, ['GLCodeTypeName', 'glCodeTypeName']) || '',
      glCodeName: firstValue(m, ['GLCodeName', 'glCodeName']) || '',
      glCodeCode: firstValue(m, ['GLCodeCode', 'glCodeCode']) || '',
      glCode: [
        firstValue(m, ['GLCodeCode', 'glCodeCode']),
        firstValue(m, ['GLCodeName', 'glCodeName']),
      ].filter(Boolean).join(' — '),
      currencyID: firstValue(p, ['CurrencyID', 'currencyID']) || '',
      currencyCode: firstValue(p, ['CurrencyCode', 'currencyCode']) || '',
      fee,
      feesToDate: actual,
      remaining: fee - actual,
      actualMonths: isServices ? {} : (expenseActuals.monthsByModule.get(moduleKey) || {}),
      expenseCurrencyIssueCount: isServices || !currencyIssue ? 0 : currencyIssue.count,
      months,
      // Which system owns `months`. The UI decides editability from this, not
      // from the active tab, so the two cannot drift apart.
      monthsSource: isServices ? 'projectworks' : 'store',
    };
  });

  const missingCustomFields = MODULE_CUSTOM_FIELDS
    .filter((field) => !customFieldsMatched.has(field.key))
    .map((field) => field.label);
  if (options.logDiagnostics && missingCustomFields.length) {
    console.warn(`Configured module custom fields not found in this tenant: ${missingCustomFields.join(', ')}`);
  }
  if (options.logDiagnostics && usedOrdinalCustomFieldMapping) {
    console.warn('Module custom fields were matched by ordinal position. Re-check the mapping after any Projectworks custom-field reorder.');
  }

  rows.sort((a, b) =>
    String(a.projectName).localeCompare(String(b.projectName), undefined, { numeric: true, sensitivity: 'base' }) ||
    String(DEFAULT_STAGE_SORT === 'stageNumber' ? a.stageNumber : a.stageName)
      .localeCompare(String(DEFAULT_STAGE_SORT === 'stageNumber' ? b.stageNumber : b.stageName), undefined, { numeric: true, sensitivity: 'base' }) ||
    String(a.stageName).localeCompare(String(b.stageName), undefined, { numeric: true, sensitivity: 'base' })
  );

  const currencyCodes = [...new Set(rows.map((row) => row.currencyCode).filter(Boolean))].sort();
  const expenseCurrencyIssueCount = [...expenseActuals.currencyIssuesByModule.values()]
    .reduce((sum, issue) => sum + issue.count, 0);

  // A configured expense status that is neither an ID nor a known name can only
  // match a status-name field on the claim. If the claims carry none, that
  // value matches nothing: logged, so an operator can set the numeric ID.
  const claimsHaveStatusNames = expenseClaims.some((claim) =>
    firstValue(claim, ['ExpenseClaimStatusName', 'expenseClaimStatusName', 'StatusName', 'statusName']) !== undefined);
  const unresolvedExpenseStatuses = EXPENSE_STATUS_FILTER.resolved
    .filter((entry) => entry.source === 'name-field' && expenseClaims.length && !claimsHaveStatusNames)
    .map((entry) => entry.configured);
  if (options.logDiagnostics) {
    if (unresolvedExpenseStatuses.length) {
      console.warn(
        `EXPENSE_STATUS_CODES value(s) ${unresolvedExpenseStatuses.map((v) => `"${v}"`).join(', ')} could not be resolved: ` +
        'expense claims carry only a numeric status ID. Set the numeric ID(s) instead. ' +
        `IDs seen: ${[...expenseActuals.statusesSeen].sort().join(', ') || 'none'}.`
      );
    }
    const excluded = expenseCurrencyIssueCount + expenseActuals.missingModule + expenseActuals.missingAmount + expenseActuals.missingDate;
    if (excluded) {
      console.warn(`${excluded} approved expense claim(s) excluded from Consultant Fees to Date: ` +
        `${expenseCurrencyIssueCount} currency mismatch, ${expenseActuals.missingModule} without a stage, ` +
        `${expenseActuals.missingAmount} without an amount, ${expenseActuals.missingDate} without a date`);
    }
  }

  const buildMs = Date.now() - buildStarted;
  const snapshotAgeMs = Date.now() - sources.fetchedAt;
  console.log(
    `grid ${startMonth}..${endMonth}: ${rows.length} of ${sources.modules.length} stages, ${projects.length} of ` +
    `${sources.projects.length} active projects (office ${officeID || 'all'}); ` +
    `sources ${fromSnapshot ? `from snapshot (age ${seconds(snapshotAgeMs)})` : `fetched in ${sources.fetchMs}ms`}, ` +
    `build ${buildMs}ms`
  );

  return {
    rows,
    netRows: buildNetRows(rows, inWindow),
    supplierLines,
    meta: {
      projects: projects.length,
      officeFilter: officeID,
      offices,
      modules: modules.length,
      invoices: invoices.length,
      expenseClaims: expenseClaims.length,
      forecastEntries: forecasts.length,
      fetchMs: sources.fetchMs,
      buildMs,
      fromSnapshot,
      fetchedAt: new Date(sources.fetchedAt).toISOString(),
      snapshotAgeMs,
      refresh: refreshStatus(options.refresh),
      invoiceStatusesSeen: [...invoiceActuals.statusesSeen].filter(Boolean),
      expenseActualsAsOf: asOfDate,
      customFieldLabels: MODULE_CUSTOM_FIELD_LABELS,
      defaultStageSort: DEFAULT_STAGE_SORT,
      currencyCodes,
      writesEnabled: ALLOW_WRITES,
      baseUrl: BASE_URL,
      tenant: RESOLVED_TENANT ? RESOLVED_TENANT.name : '',
    },
  };
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
// Hosting health checks need one non-sensitive route that does not require the
// browser password. The process only begins listening after tenant and storage
// checks pass; each probe also confirms Postgres remains reachable.
app.get('/healthz', async (_req, res) => {
  try {
    await storage.ping();
    res.json({ ok: true });
  } catch (err) {
    console.error(`Health check failed: ${String(err.message || err)}`);
    res.status(503).json({ ok: false });
  }
});
app.use(requireBasicAuth); // first, so the static handler is gated too
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function writesBlocked(res) {
  if (ALLOW_WRITES) return false;
  res.status(403).json({
    error: 'Writes are disabled. Set ALLOW_WRITES=true in .env to enable edits.',
  });
  return true;
}

function positiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function finiteNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function monthRangeSize(start, end) {
  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);
  return (endYear - startYear) * 12 + endMonth - startMonth + 1;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL,
    // Resolved from the API at boot and matched against PW_TENANT_LOCK, so the
    // header chip names the tenant instead of the host every tenant shares.
    tenant: RESOLVED_TENANT ? RESOLVED_TENANT.name : '',
    tenantNames: RESOLVED_TENANT ? RESOLVED_TENANT.names : [],
    tenantOffices: RESOLVED_TENANT ? RESOLVED_TENANT.offices : [],
    authMode: AUTH_MODE,
    writesEnabled: ALLOW_WRITES,
    invoiceStatusFilter: STATUS_CODES,
    expenseStatusFilter: EXPENSE_STATUS_CODES,
    expenseStatusResolution: EXPENSE_STATUS_FILTER.resolved,
    archivedProjectStatuses: ARCHIVED_PROJECT_STATUSES,
    customFieldLabels: MODULE_CUSTOM_FIELD_LABELS,
    defaultStageSort: DEFAULT_STAGE_SORT,
    requestTimeoutMs: PW_REQUEST_TIMEOUT_MS,
    // Required at boot; retained for compatibility with the existing UI.
    invoiceStatusFiltered: STATUS_CODES.length > 0,
    appBaseUrl: APP_BASE_URL,
  });
});

const flag = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

/** start/end from the query as a forecast range, or an error message. */
function parseWindow(query) {
  const { start, end } = query;
  if (!isMonth(start) || !isMonth(end)) return { error: 'start and end are required as YYYY-MM' };
  const months = monthRangeSize(start, end);
  if (months < 1 || months > 36) return { error: 'forecast range must be between 1 and 36 months' };
  return { start, end, windowKey: windowKeyOf(start, end) };
}

/**
 * The grid, built from the range's snapshot. With no snapshot yet (or
 * fresh=1) the sources are read in the foreground, joining any refresh already
 * running. ifCached=1 never reads Projectworks: with no snapshot it answers
 * { snapshot: false } — the page-load path, which must be instant.
 */
app.get('/api/grid', async (req, res) => {
  const range = parseWindow(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const office = String(req.query.office || '').trim();
  if (office && office !== 'all' && !/^\d+$/.test(office)) {
    return res.status(400).json({ error: 'office must be "all" or a numeric OfficeID' });
  }
  try {
    let sources = flag(req.query.fresh) ? null : await getSnapshot(range.windowKey);
    const fromSnapshot = !!sources;
    if (!sources) {
      if (flag(req.query.ifCached)) {
        return res.json({ snapshot: false, refresh: refreshStatus(refreshJobs.get(range.windowKey)) });
      }
      const job = startRefresh(range.start, range.end);
      sources = await job.promise;
      if (!sources) throw new Error(job.error || 'no grid data could be read');
    }
    res.json(await buildGrid(sources, {
      officeID: office === 'all' ? '' : office,
      fromSnapshot,
      refresh: refreshJobs.get(range.windowKey),
    }));
  } catch (err) {
    // Logged in full here; the browser gets no upstream detail.
    console.error(err);
    res.status(503).json({ error: 'unavailable' });
  }
});

/** "Load data": start (or join) a background refresh of the range. Read-only against Projectworks. */
app.post('/api/grid/refresh', (req, res) => {
  const range = parseWindow(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  res.status(202).json(refreshStatus(startRefresh(range.start, range.end, { full: flag(req.query.full) })));
});

/** Progress of the range's latest refresh: idle, running (per-phase), done or error. */
app.get('/api/grid/refresh', (req, res) => {
  const range = parseWindow(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  res.json(refreshStatus(refreshJobs.get(range.windowKey)));
});

app.get('/api/offices', async (_req, res) => {
  try {
    res.json({ offices: await getOffices() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/users', async (_req, res) => {
  try {
    res.json({ users: await getProjectworksUsers(false) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.post('/api/forecast', async (req, res) => {
  if (writesBlocked(res)) return;
  const { moduleID, month, amount, context } = req.body || {};
  const moduleNumber = positiveSafeInteger(moduleID);
  const amountNumber = finiteNumber(amount);
  const ctx = context || {};
  const hasExpectedValue = Object.prototype.hasOwnProperty.call(ctx, 'from');
  const expectedAmount = ctx.from === '' ? 0 : finiteNumber(ctx.from);
  if (!moduleNumber || !isMonth(month) || amountNumber === null || !hasExpectedValue || expectedAmount === null) {
    return res.status(400).json({ error: 'moduleID, month (YYYY-MM) and numeric amount are required' });
  }
  let auditUser;
  let previousAmount;
  let servicesModule;
  try {
    auditUser = await resolveSelectedAuditUser(req.body);
    // The only route that writes to Projectworks, so this is the only place the
    // consultant/services boundary has to hold. It fails closed.
    servicesModule = await assertServicesModule(moduleNumber);
    // The audit's previous value is read from Projectworks, never trusted from
    // browser-supplied context. If it cannot be read, the write is refused.
    previousAmount = await pwForecastAmount(moduleNumber, month);
    if (Math.abs(previousAmount - expectedAmount) > 0.000001) {
      throw httpError(409, 'This forecast changed in Projectworks after the grid was loaded. Reload before editing it again.');
    }
  } catch (err) {
    return sendUserResolveError(res, err);
  }
  // User-selection based audit labeling for demo/internal use only. This is
  // not authenticated identity; secure attribution needs SSO or delegated auth.
  const result = await pwSetForecast(
    moduleNumber, month, amountNumber,
    `Set by ${auditUser.name} via PW Billing Forecast tool`
  );
  try {
    await storage.transaction(async (tx) => {
      await tx.appendAudit({
        user: auditUser.name,
        projectworksUserID: auditUser.id,
        action: 'forecast.set',
        target: 'projectworks',
        project: ctx.project || '',
        stage: ctx.stage || '',
        supplier: '',
        moduleID: moduleNumber,
        month,
        from: previousAmount,
        to: amountNumber,
        synced: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });
    });
  } catch (err) {
    return sendStoreError(res, err, result.ok
      ? 'The forecast WAS written to Projectworks; only the audit entry was lost.'
      : '');
  }
  if (!result.ok) return res.status(502).json({ error: result.error });
  // Snapshots showing this cell are patched, not re-read.
  await recordForecastWrite(moduleNumber, firstValue(servicesModule, PROJECT_ID_KEYS), month, amountNumber);
  res.json({ ok: true });
});

// ---- supplier lines --------------------------------------------------------

app.get('/api/supplier-lines', async (req, res) => {
  try {
    const { moduleID } = req.query;
    const moduleNumber = moduleID === undefined ? undefined : positiveSafeInteger(moduleID);
    if (moduleID !== undefined && !moduleNumber) return res.status(400).json({ error: 'moduleID must be a positive integer' });
    const lines = await storage.getSupplierLines(moduleNumber);
    res.json({ supplierLines: lines });
  } catch (err) {
    sendStoreError(res, err);
  }
});

app.post('/api/supplier-lines', async (req, res) => {
  if (writesBlocked(res)) return;
  const { moduleID, supplier, description, context } = req.body || {};
  const moduleNumber = positiveSafeInteger(moduleID);
  if (!moduleNumber || !supplier || !String(supplier).trim()) {
    return res.status(400).json({ error: 'moduleID and supplier are required' });
  }
  let auditUser;
  try {
    auditUser = await resolveSelectedAuditUser(req.body);
    await assertConsultantModule(moduleNumber);
  } catch (err) {
    return sendUserResolveError(res, err);
  }
  const ctx = context || {};
  try {
    const line = await storage.transaction(async (tx) => {
      const created = await tx.createSupplierLine({
        moduleID: moduleNumber,
        supplier: String(supplier).trim(),
        description: description ? String(description) : '',
      });
      await tx.appendAudit({
        user: auditUser.name,
        projectworksUserID: auditUser.id,
        action: 'supplier.add',
        target: 'app',
        project: ctx.project || '',
        stage: ctx.stage || '',
        supplier: created.supplier,
        moduleID: created.moduleID,
        month: '',
        from: '',
        to: '',
      });
      return created;
    });
    res.json({ ok: true, line });
  } catch (err) {
    sendStoreError(res, err);
  }
});

/**
 * Set one month cell on a supplier line. App-side only — nothing here reaches
 * Projectworks. `moduleTotal` is the app-side rollup shown on the module row:
 * a planning figure, not a forecast.
 */
app.put('/api/supplier-lines/:id/month', async (req, res) => {
  if (writesBlocked(res)) return;
  const id = positiveSafeInteger(req.params.id);
  const { month, amount, context } = req.body || {};
  const amountNumber = finiteNumber(amount);
  const ctx = context || {};
  const hasExpectedValue = Object.prototype.hasOwnProperty.call(ctx, 'from');
  const expectedAmount = ctx.from === '' ? 0 : finiteNumber(ctx.from);
  if (!id || !isMonth(month) || amountNumber === null || !hasExpectedValue || expectedAmount === null) {
    return res.status(400).json({ error: 'month (YYYY-MM) and numeric amount are required' });
  }
  let auditUser;
  try {
    auditUser = await resolveSelectedAuditUser(req.body);
    await supplierLineForWrite(id);
  } catch (err) {
    return sendUserResolveError(res, err);
  }
  try {
    const out = await storage.transaction(async (tx) => {
      const changed = await tx.setSupplierLineMonth(id, month, amountNumber, expectedAmount);
      if (!changed) return { status: 404, body: { error: `supplier line ${id} not found` } };

      await tx.appendAudit({
        user: auditUser.name,
        projectworksUserID: auditUser.id,
        action: 'supplier.set',
        target: 'app',
        project: ctx.project || '',
        stage: ctx.stage || '',
        supplier: changed.line.supplier,
        moduleID: changed.line.moduleID,
        month,
        from: changed.from,
        to: amountNumber,
      });
      return { status: 200, body: { ok: true, moduleTotal: changed.moduleTotal } };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    sendStoreError(res, err);
  }
});

app.delete('/api/supplier-lines/:id', async (req, res) => {
  if (writesBlocked(res)) return;
  const id = positiveSafeInteger(req.params.id);
  const { context } = req.body || {};
  if (!id) return res.status(400).json({ error: 'supplier line id must be a positive integer' });
  let auditUser;
  try {
    auditUser = await resolveSelectedAuditUser(req.body);
    await supplierLineForWrite(id);
  } catch (err) {
    return sendUserResolveError(res, err);
  }
  const ctx = context || {};
  try {
    const out = await storage.transaction(async (tx) => {
      const line = await tx.deleteSupplierLine(id);
      if (!line) return { status: 404, body: { error: `supplier line ${id} not found` } };

      await tx.appendAudit({
        user: auditUser.name,
        projectworksUserID: auditUser.id,
        action: 'supplier.delete',
        target: 'app',
        project: ctx.project || '',
        stage: ctx.stage || '',
        supplier: line.supplier,
        moduleID: line.moduleID,
        month: '',
        from: '',
        to: '',
      });
      return { status: 200, body: { ok: true } };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    sendStoreError(res, err);
  }
});

// ---- audit -----------------------------------------------------------------

app.get('/api/audit', async (_req, res) => {
  try {
    res.json({ audit: await storage.getAudit(100) });
  } catch (err) {
    sendStoreError(res, err);
  }
});

// ---- boot ------------------------------------------------------------------

// The tenant lock is resolved from the API before the database is touched and
// before the server accepts a single request, so a wrong credential never gets
// to serve — or write — anything.
(async () => {
  RESOLVED_TENANT = await enforceTenantLock();
  const storageStatus = await storage.initialize({ seedDemoData: SEED_DEMO_DATA, seedPath: SEED_PATH });
  const appBaseWarning = appBaseUrlTenantWarning(RESOLVED_TENANT.names);

  app.listen(PORT, HOST, () => {
    console.log(`pw-billing-forecast listening on ${HOST}:${PORT}`);
    console.log(`  Tenant:    ${RESOLVED_TENANT.name} (matches PW_TENANT_LOCK)`);
    console.log(`  API base:  ${BASE_URL}`);
    console.log(`  Auth mode: ${AUTH_MODE}`);
    console.log(`  Writes:    ${ALLOW_WRITES ? 'ENABLED' : 'disabled (read-only)'}`);
    console.log(`  Gate:      ${AUTH_DISABLED ? 'DISABLED' : `HTTP Basic (user "${BASIC_AUTH_USER}")`}`);
    console.log(`  Database:  connected (instance "${STORAGE_CONFIG.instanceId}")`);
    console.log(`  Invoices:  counting status ${STATUS_CODES.map((c) => `"${c}"`).join(', ')}`);
    console.log(`  Expenses:  counting status ${EXPENSE_STATUS_FILTER.resolved.map((r) =>
      r.id ? `"${r.configured}" → ID ${r.id}${r.source === 'built-in' ? ' (built-in mapping)' : ''}` : `"${r.configured}" (by name, if claims carry one)`).join(', ')}`);
    console.log(`  Archived:  projects with IsActive=false or status ${ARCHIVED_PROJECT_STATUSES.map((n) => `"${n}"`).join(', ')} are never read or shown`);
    if (storageStatus.trimmedAuditEntries) {
      console.log(`  Audit:     removed ${storageStatus.trimmedAuditEntries} entries over AUDIT_RETENTION_LIMIT`);
    }

    if (SEED_DEMO_DATA) {
      warnBanner([
        'SEED_DEMO_DATA=true — a brand-new empty dataset for this INSTANCE_ID is',
        'filled from seed.json, whose suppliers are pinned to a demo moduleID.',
        'Never set this on a customer deployment.',
      ]);
    }

    if (appBaseWarning) warnBanner(appBaseWarning);

    if (AUTH_DISABLED) {
      console.warn('');
      console.warn('  ****************************************************************');
      console.warn('  *  WARNING: AUTH_DISABLED=true — user-facing routes are open   *');
      console.warn('  *  who can reach this server, including the write endpoints.    *');
      console.warn('  *  Never set this on a hosted or public deployment.             *');
      console.warn('  ****************************************************************');
      console.warn('');
    }

    console.log(`  Modules:   read per active project, ${MODULE_FETCH_CONCURRENCY} at a time; ` +
      `incremental refresh, full sync every ${FULL_SYNC_INTERVAL_MS / 3600000}h`);
    console.log('  Diagnostics: logged after the first grid refresh (nothing is read at boot)');

    // Restore the default window's snapshot (current month + 11, as the UI
    // opens with) from Postgres, so the first page load is served from memory.
    // No Projectworks call.
    const now = new Date();
    const ym = (offset) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15)).toISOString().slice(0, 7);
    getSnapshot(windowKeyOf(ym(0), ym(11)));
  });
})().catch((err) => {
  refuseToStart([
    'A required startup check failed. The server did not start:',
    '',
    `  ${String(err && err.stack ? err.stack : err)}`,
  ]);
});
