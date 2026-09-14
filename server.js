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
 *   GET  /api/grid?start&end      — { rows, netRows, supplierLines, meta }
 *                                   netRows is the read-only Net position view:
 *                                   one row per project, planned invoicing minus
 *                                   subconsultant fees, per month.
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
const { createStorage, readStorageConfig } = require('./storage');
const {
  aggregateExpenseActuals,
  aggregateForecasts,
  aggregateInvoiceFees,
  buildNetRows,
  collectPages,
  compareTenantOfficeNames,
  firstValue,
  isMonth,
  moduleMonthTotals,
  resolveModuleCustomFields,
} = require('./app-logic');

const BASE_URL = (process.env.PW_BASE_URL || '').replace(/\/+$/, '');
const APP_BASE_URL = (process.env.PW_APP_BASE_URL || '').replace(/\/+$/, '');
const AUTH_MODE = (process.env.AUTH_MODE || '').toLowerCase();
const TENANT_LOCK_NAMES = (process.env.PW_TENANT_LOCK || '')
  .split(',')
  .map((name) => name.trim().replace(/\s+/g, ' '))
  .filter(Boolean);
const TENANT_LOCK = TENANT_LOCK_NAMES.join(', ');
const ALLOW_WRITES = process.env.ALLOW_WRITES === 'true';
const STORAGE_CONFIG = readStorageConfig();
const SEED_DEMO_DATA = process.env.SEED_DEMO_DATA === 'true';
const SEED_PATH = path.join(__dirname, 'seed.json');
const STATUS_CODES = (process.env.INVOICE_STATUS_CODES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const EXPENSE_STATUS_CODES = (process.env.EXPENSE_STATUS_CODES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODULE_CUSTOM_FIELD_LABELS = (process.env.MODULE_CUSTOM_FIELD_LABELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODULE_CUSTOM_FIELD_KEYS = ['stageNumber', 'riskStatus', 'fixedHourly'];
const MODULE_CUSTOM_FIELDS = MODULE_CUSTOM_FIELD_KEYS.map((key, index) => ({
  key,
  label: MODULE_CUSTOM_FIELD_LABELS[index] || '',
}));
const MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID = String(process.env.MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID || '').trim();
const DEFAULT_STAGE_SORT = String(process.env.DEFAULT_STAGE_SORT || '').trim();
const PW_REQUEST_TIMEOUT_MS = Number(process.env.PW_REQUEST_TIMEOUT_MS);

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
const PAGE_SIZE = 200;
const MAX_PAGES = 100; // hard stop: 20,000 records per collection
const USER_PAGE_SIZE = 500;
const USER_CACHE_MS = 5 * 60 * 1000;
let usersCache = { at: 0, users: [], byID: new Map() };

async function pwGet(pathname, params = {}) {
  const url = new URL(BASE_URL + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', ...authHeaders() },
      signal: AbortSignal.timeout(PW_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Error(
      `GET ${pathname} ${timedOut ? `timed out after ${PW_REQUEST_TIMEOUT_MS}ms` : `failed: ${String(err.message || err)}`}`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GET ${pathname} → ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Page through a collection endpoint until a short page comes back. */
async function pwGetAll(pathname, params = {}) {
  return collectPages(
    (page, pageSize) => pwGet(pathname, { ...params, page, pageSize }),
    { pageSize: PAGE_SIZE, maxPages: MAX_PAGES, label: `GET ${pathname}` }
  );
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
        entityTypeIssue = 'Projectworks did not return an entity type named Module.';
      }
    } catch (err) {
      entityTypeIssue = `Module custom-field entity type could not be discovered: ${String(err.message || err)}`;
    }
  }

  const scope = entityTypeID ? { EntityTypeID: entityTypeID } : {};
  const [rawDefinitions, ...labelGroups] = await Promise.all([
    pwGetAll('/api/v1/CustomFields', scope),
    ...MODULE_CUSTOM_FIELDS.map((field) => pwGetAll('/api/v1/CustomFields', { ...scope, Label: field.label })),
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
  const projects = await pwGetAll('/api/v1/Projects');
  const names = new Set();
  for (const p of projects) {
    const name = String(firstValue(p, ['OfficeName', 'officeName']) || '').trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the tenant and compare its exact office-name set to PW_TENANT_LOCK.
 * Fails closed: every path that does not end in a confirmed match stops the
 * server. Returns { name, names, offices } on success.
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
      'TENANT MISMATCH — the credential did not return the exact expected office set.',
      '',
      `  Expected (PW_TENANT_LOCK): "${TENANT_LOCK}"`,
      `  Actual (from the API):     "${offices.join('", "')}"`,
      ...(comparison.missing.length ? [`  Missing expected office(s):  "${comparison.missing.join('", "')}"`] : []),
      ...(comparison.unexpected.length ? [`  Unexpected office(s):       "${comparison.unexpected.join('", "')}"`] : []),
      '',
      `  API host: ${new URL(BASE_URL).host} (identical for every tenant, so it`,
      '            proves nothing on its own)',
      '',
      'The credential in PW_USERNAME / PW_PASSWORD or PW_AUTH_HEADER_VALUE',
      'belongs to a different tenant than the one this deployment is locked to.',
      'Either fix the credential, or — if re-pointing at this tenant is',
      'intended — update PW_TENANT_LOCK to the complete comma-separated office list.',
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
  const out = await collectPages(
    (page, pageSize) => fetchProjectworksUsers({ page, pageSize }),
    { pageSize: USER_PAGE_SIZE, maxPages: MAX_PAGES, label: 'GET /api/v1/Users' }
  );
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

function cacheModules(modules) {
  modulesCache = {
    at: Date.now(),
    byID: new Map(modules.map((m) => [String(firstValue(m, ['ModuleID', 'moduleID'])), m])),
  };
}

async function getModuleByID(id) {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const fresh = modulesCache.byID.size > 0 && Date.now() - modulesCache.at < MODULE_CACHE_MS;
  if (!fresh) {
    cacheModules(await pwGetAll('/api/v1/Modules'));
    return modulesCache.byID.get(wanted) || null;
  }
  const hit = modulesCache.byID.get(wanted);
  if (hit) return hit;
  // Fresh cache but a miss: the module may have been created since the pull.
  cacheModules(await pwGetAll('/api/v1/Modules'));
  return modulesCache.byID.get(wanted) || null;
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

/** Build the composed grid: one row per module (stage). */
async function buildGrid(startMonth, endMonth) {
  // Consultant Fees to Date is actual pre-tax expense spend through today.
  // Consultant month cells remain app-side planning values; the actual monthly
  // buckets are returned separately for reconciliation and future drill-down.
  const forecastStart = `${startMonth}-01`;
  const asOfDate = new Date().toISOString().slice(0, 10);
  const [projects, modules, invoices, forecasts, expenseClaims, customFieldConfig, supplierLines] = await Promise.all([
    pwGetAll('/api/v1/Projects'),
    pwGetAll('/api/v1/Modules', { IncludeCustomFields: true }),
    pwGetAll('/api/v1/Invoices'),
    pwGetAll('/api/v1/Forecasts', { StartDate: forecastStart, EndDate: monthEndDate(endMonth) }),
    pwGetAll('/api/v1/ExpenseClaims', { EndDate: `${asOfDate}T23:59:59.999Z`, IncludeCustomFields: false }),
    loadModuleCustomFieldDefinitions(),
    storage.getSupplierLines(),
  ]);
  const customFieldDefinitions = customFieldConfig.definitions;

  // Keeps the IsServices guard on /api/forecast warm off a call the grid makes anyway.
  cacheModules(modules);

  const projectById = new Map(projects.map((project) => [
    String(firstValue(project, ['ProjectID', 'projectID'])),
    project,
  ]));
  const moduleProject = new Map(modules.map((module) => [
    String(firstValue(module, ['ModuleID', 'moduleID'])),
    String(firstValue(module, ['ProjectID', 'projectID'])),
  ]));
  const projectCurrency = new Map(projects.map((project) => [
    String(firstValue(project, ['ProjectID', 'projectID'])),
    firstValue(project, ['CurrencyID', 'currencyID']),
  ]));
  const inWindow = (m) => m >= startMonth && m <= endMonth; // 'YYYY-MM' sorts lexically

  const invoiceActuals = aggregateInvoiceFees(invoices, STATUS_CODES);
  const expenseActuals = aggregateExpenseActuals(expenseClaims, {
    allowedStatusIDs: EXPENSE_STATUS_CODES,
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
  if (missingCustomFields.length) {
    console.warn(`Configured module custom fields not found in this tenant: ${missingCustomFields.join(', ')}`);
  }
  if (usedOrdinalCustomFieldMapping) {
    console.warn('Module custom fields were matched by ordinal position. Re-check the mapping after any Projectworks custom-field reorder.');
  }
  if (customFieldConfig.entityTypeIssue) console.warn(customFieldConfig.entityTypeIssue);

  rows.sort((a, b) =>
    String(a.projectName).localeCompare(String(b.projectName), undefined, { numeric: true, sensitivity: 'base' }) ||
    String(DEFAULT_STAGE_SORT === 'stageNumber' ? a.stageNumber : a.stageName)
      .localeCompare(String(DEFAULT_STAGE_SORT === 'stageNumber' ? b.stageNumber : b.stageName), undefined, { numeric: true, sensitivity: 'base' }) ||
    String(a.stageName).localeCompare(String(b.stageName), undefined, { numeric: true, sensitivity: 'base' })
  );

  const currencyCodes = [...new Set(rows.map((row) => row.currencyCode).filter(Boolean))].sort();
  const expenseCurrencyIssueCount = [...expenseActuals.currencyIssuesByModule.values()]
    .reduce((sum, issue) => sum + issue.count, 0);

  return {
    rows,
    netRows: buildNetRows(rows, inWindow),
    supplierLines,
    meta: {
      projects: projects.length,
      modules: modules.length,
      invoices: invoices.length,
      expenseClaims: expenseClaims.length,
      forecastEntries: forecasts.length,
      invoiceStatusFilter: STATUS_CODES.length ? STATUS_CODES : 'ALL (unfiltered — confirm before demoing revenue figures)',
      invoiceStatusesSeen: [...invoiceActuals.statusesSeen].filter(Boolean),
      expenseStatusFilter: EXPENSE_STATUS_CODES,
      expenseStatusesSeen: [...expenseActuals.statusesSeen].filter(Boolean),
      expenseActualsAsOf: asOfDate,
      expenseCurrencyIssueCount,
      expenseMissingModuleCount: expenseActuals.missingModule,
      expenseMissingAmountCount: expenseActuals.missingAmount,
      expenseMissingDateCount: expenseActuals.missingDate,
      expensePlannedExcluded: expenseActuals.plannedExcluded,
      expenseFutureExcluded: expenseActuals.futureExcluded,
      missingCustomFields,
      customFieldMapping: missingCustomFields.length === MODULE_CUSTOM_FIELDS.length
        ? 'unresolved'
        : (usedOrdinalCustomFieldMapping ? 'ordinal' : 'identity'),
      customFieldLabels: MODULE_CUSTOM_FIELD_LABELS,
      customFieldEntityTypeID: customFieldConfig.entityTypeID,
      customFieldEntityTypeSource: customFieldConfig.entityTypeSource,
      customFieldEntityTypeIssue: customFieldConfig.entityTypeIssue,
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
    customFieldLabels: MODULE_CUSTOM_FIELD_LABELS,
    defaultStageSort: DEFAULT_STAGE_SORT,
    requestTimeoutMs: PW_REQUEST_TIMEOUT_MS,
    // Required at boot; retained for compatibility with the existing UI.
    invoiceStatusFiltered: STATUS_CODES.length > 0,
    appBaseUrl: APP_BASE_URL,
  });
});

app.get('/api/grid', async (req, res) => {
  const { start, end } = req.query;
  if (!isMonth(start) || !isMonth(end)) {
    return res.status(400).json({ error: 'start and end are required as YYYY-MM' });
  }
  const months = monthRangeSize(start, end);
  if (months < 1 || months > 36) {
    return res.status(400).json({ error: 'forecast range must be between 1 and 36 months' });
  }
  try {
    res.json(await buildGrid(start, end));
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
  try {
    auditUser = await resolveSelectedAuditUser(req.body);
    // The only route that writes to Projectworks, so this is the only place the
    // consultant/services boundary has to hold. It fails closed.
    await assertServicesModule(moduleNumber);
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

  });
})().catch((err) => {
  refuseToStart([
    'A required startup check failed. The server did not start:',
    '',
    `  ${String(err && err.stack ? err.stack : err)}`,
  ]);
});
