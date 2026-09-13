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

const BASE_URL = (process.env.PW_BASE_URL || '').replace(/\/+$/, '');
const APP_BASE_URL = (process.env.PW_APP_BASE_URL || '').replace(/\/+$/, '');
const AUTH_MODE = (process.env.AUTH_MODE || '').toLowerCase();
const TENANT_LOCK = (process.env.PW_TENANT_LOCK || '').trim();
const ALLOW_WRITES = process.env.ALLOW_WRITES === 'true';
const STORAGE_CONFIG = readStorageConfig();
const SEED_DEMO_DATA = process.env.SEED_DEMO_DATA === 'true';
const SEED_PATH = path.join(__dirname, 'seed.json');
const STATUS_CODES = (process.env.INVOICE_STATUS_CODES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

const missingConfig = [];
if (!BASE_URL) missingConfig.push('PW_BASE_URL is not set (Projectworks Open API base URL).');
if (!TENANT_LOCK) {
  missingConfig.push(
    'PW_TENANT_LOCK is not set (the expected Projectworks tenant name — the office ' +
    'name configured in that tenant). Without it the server cannot tell which tenant ' +
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
// so every route — including the static file handler — sits behind this gate.
// It fails closed: no password, no server, unless AUTH_DISABLED=true says so.
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
      'Every route is gated behind HTTP Basic auth. Set both variables, or set',
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

/**
 * The app-side rollup: the total planned across every supplier line on a
 * module for one month. This is the read-side definition used to compose the
 * grid from the supplier-line rows returned by Postgres.
 * It is a planning figure and is never sent to Projectworks.
 */
function moduleMonthTotal(supplierLines, moduleID, month) {
  return supplierLines
    .filter((l) => l.moduleID === moduleID)
    .reduce((s, l) => s + (Number(l.months[month]) || 0), 0);
}

/**
 * Net position: one row per PROJECT, aggregated from the stage rows the grid
 * has already built. Deriving it from those rows rather than re-reading the
 * sources is deliberate — the two components are then the same numbers the
 * Gross fees and Consultant fees tabs display, by construction, and cannot
 * drift from them.
 *
 *   plannedMonths     sum of month values across the project's SERVICES stages
 *                     (Projectworks Forecasts — what the customer plans to
 *                     invoice its clients)
 *   consultantMonths  sum of month values across the project's NON-SERVICES
 *                     stages (this app's store — subconsultant fees it expects
 *                     to be charged; never read from Projectworks)
 *   months            net = planned − consultant, per month
 *
 * Read-only, and no new source of truth: nothing here writes anywhere.
 */
function buildNetRows(rows, inWindow) {
  const byProject = new Map();

  for (const r of rows) {
    let n = byProject.get(r.projectID);
    if (!n) {
      n = {
        projectID: r.projectID,
        parentNumber: r.parentNumber,
        projectName: r.projectName || `Project ${r.projectID}`,
        projectManagerName: r.projectManagerName,
        projectType: r.projectType,
        isActive: false,
        servicesStages: 0,
        consultantStages: 0,
        plannedMonths: {},
        consultantMonths: {},
        months: {},
      };
      byProject.set(r.projectID, n);
    }
    if (r.isActive) n.isActive = true;
    if (r.isServices) n.servicesStages++; else n.consultantStages++;

    const bucket = r.isServices ? n.plannedMonths : n.consultantMonths;
    for (const [month, value] of Object.entries(r.months)) {
      if (!inWindow(month)) continue;
      bucket[month] = (bucket[month] || 0) + (Number(value) || 0);
    }
  }

  const out = [];
  for (const n of byProject.values()) {
    // Same emptiness reasoning the other tabs use for "no forecast": a project
    // counts as having something to show when a month KEY exists, so a stage
    // deliberately forecast at 0 still renders, and a project with neither a
    // forecast nor a supplier line in the window is dropped rather than
    // rendered as a row of blanks.
    const plannedKeys = Object.keys(n.plannedMonths);
    const consultantKeys = Object.keys(n.consultantMonths);
    if (!plannedKeys.length && !consultantKeys.length) continue;

    for (const month of new Set([...plannedKeys, ...consultantKeys])) {
      n.months[month] = (n.plannedMonths[month] || 0) - (n.consultantMonths[month] || 0);
    }
    const total = (obj) => Object.values(obj).reduce((s, v) => s + (Number(v) || 0), 0);
    n.plannedTotal = total(n.plannedMonths);
    n.consultantTotal = total(n.consultantMonths);
    n.netTotal = n.plannedTotal - n.consultantTotal;
    out.push(n);
  }

  out.sort((a, b) =>
    String(a.parentNumber).localeCompare(String(b.parentNumber)) ||
    String(a.projectName).localeCompare(String(b.projectName))
  );
  return out;
}

/** Every month any supplier line on this module carries, as { 'YYYY-MM': total }. */
function moduleMonthTotals(supplierLines, moduleID, withinMonths) {
  const lines = supplierLines.filter((l) => l.moduleID === moduleID);
  const out = {};
  for (const line of lines) {
    for (const month of Object.keys(line.months || {})) {
      if (withinMonths && !withinMonths(month)) continue;
      if (out[month] === undefined) out[month] = moduleMonthTotal(lines, moduleID, month);
    }
  }
  return out;
}

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
  const res = await fetch(url, { headers: { Accept: 'application/json', ...authHeaders() } });
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
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await pwGet(pathname, { ...params, page, pageSize: PAGE_SIZE });
    if (!Array.isArray(batch)) {
      throw new Error(`GET ${pathname} returned a non-array response; check the endpoint shape.`);
    }
    out.push(...batch);
    if (batch.length < PAGE_SIZE) return out;
  }
  console.warn(`GET ${pathname}: hit MAX_PAGES (${MAX_PAGES}); results may be truncated.`);
  return out;
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

let RESOLVED_TENANT = null; // { name, offices } — set during boot, before listen

/** Case- and whitespace-insensitive form used for every tenant comparison. */
function normalizeTenantName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Letters and digits only — for the loose PW_APP_BASE_URL subdomain check. */
function alphanumeric(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The distinct office names this credential can see, sorted. One page of
 * projects is enough to identify the tenant; this is the same GET
 * /api/v1/Projects the grid already calls, with the same paging parameters.
 */
async function resolveTenantOfficeNames() {
  const projects = await pwGet('/api/v1/Projects', { page: 1, pageSize: PAGE_SIZE });
  if (!Array.isArray(projects)) {
    throw new Error('GET /api/v1/Projects returned a non-array response; check the endpoint shape.');
  }
  const names = new Set();
  for (const p of projects) {
    const name = String(p?.OfficeName || '').trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the tenant and compare it to PW_TENANT_LOCK. Fails closed: every
 * path that does not end in a confirmed match stops the server. Returns
 * { name, offices } on success.
 */
async function enforceTenantLock() {
  const lockKey = normalizeTenantName(TENANT_LOCK);

  if (DEFAULT_OFFICE_NAMES.has(lockKey)) {
    refuseToStart([
      `PW_TENANT_LOCK is set to "${TENANT_LOCK}", which is the default office name`,
      'Projectworks gives every new tenant. It identifies nothing: any other',
      'sandbox whose office has not been renamed would satisfy this lock too.',
      '',
      'Give this tenant a distinctive office name in Projectworks',
      '(Settings → Offices), then set PW_TENANT_LOCK to that name.',
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

  const match = offices.find((name) => normalizeTenantName(name) === lockKey);
  if (!match) {
    refuseToStart([
      'TENANT MISMATCH — this credential is not for the expected tenant.',
      '',
      `  Expected (PW_TENANT_LOCK): "${TENANT_LOCK}"`,
      `  Actual (from the API):     "${offices.join('", "')}"`,
      '',
      `  API host: ${new URL(BASE_URL).host} (identical for every tenant, so it`,
      '            proves nothing on its own)',
      '',
      'The credential in PW_USERNAME / PW_PASSWORD or PW_AUTH_HEADER_VALUE',
      'belongs to a different tenant than the one this deployment is locked to.',
      'Either fix the credential, or — if re-pointing at this tenant is',
      'intended — update PW_TENANT_LOCK to the actual tenant name.',
    ]);
  }

  return { name: match, offices };
}

/**
 * PW_APP_BASE_URL drives the deep links out of the grid. Its subdomain is the
 * tenant's web app; if that does not look like the tenant the data came from,
 * every link in the UI points at a different tenant than the numbers. Warned
 * about loudly rather than fatal — the links are cosmetic, the data is not.
 */
function appBaseUrlTenantWarning(tenantName) {
  if (!APP_BASE_URL) return null;

  let host;
  try {
    host = new URL(APP_BASE_URL).host;
  } catch {
    return [`PW_APP_BASE_URL is not a valid URL (${APP_BASE_URL}); deep links will be wrong.`];
  }

  const subdomain = host.split('.')[0] || '';
  const sub = alphanumeric(subdomain);
  const tenant = alphanumeric(tenantName);
  if (!sub || !tenant || sub.includes(tenant) || tenant.includes(sub)) return null;

  return [
    'PW_APP_BASE_URL does not match the resolved tenant.',
    '',
    `  Resolved tenant: ${tenantName}`,
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
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchProjectworksUsers({ page, pageSize: USER_PAGE_SIZE });
    out.push(...batch);
    if (batch.length < USER_PAGE_SIZE) break;
  }
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
    byID: new Map(modules.map((m) => [String(m.ModuleID), m])),
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
  if (!module.IsServices) {
    throw httpError(
      403,
      `Module ${moduleID} is a consultant (non-services) module. Subconsultant fees are ` +
      'planning numbers held in this app and are never written to Projectworks. ' +
      'Edit them on the supplier lines of the Consultant fees tab.'
    );
  }
  return module;
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
  return res.status(500).json({
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

function monthKey(dateStr) {
  // Forecast/invoice dates arrive as ISO strings; bucket to YYYY-MM.
  return String(dateStr).slice(0, 7);
}

/** Build the composed grid: one row per module (stage). */
async function buildGrid(startMonth, endMonth) {
  // Forecasts are date-bounded to the requested window; the other Projectworks
  // collections are full pulls (fees to date is all-time). Supplier lines are
  // read from Postgres in parallel and never from Projectworks.
  // The live API returns PascalCase fields (ModuleID, Budget, IsServices, …)
  // — verified against the sandbox tenant, not the swagger's casing.
  const forecastStart = `${startMonth}-01`;
  const [projects, modules, invoices, forecasts, supplierLines] = await Promise.all([
    pwGetAll('/api/v1/Projects'),
    pwGetAll('/api/v1/Modules'),
    pwGetAll('/api/v1/Invoices'),
    pwGetAll('/api/v1/Forecasts', { StartDate: forecastStart, EndDate: `${endMonth}-28` }),
    storage.getSupplierLines(),
  ]);

  // Keeps the IsServices guard on /api/forecast warm off a call the grid makes anyway.
  cacheModules(modules);

  const projectById = new Map(projects.map((p) => [p.ProjectID, p]));
  const inWindow = (m) => m >= startMonth && m <= endMonth; // 'YYYY-MM' sorts lexically

  // Fees to date: sum invoice line amounts by ModuleID, optionally filtered
  // to configured invoice status codes. Lines ride inside invoice headers.
  const feesToDate = new Map();
  const statusesSeen = new Set();
  for (const inv of invoices) {
    statusesSeen.add(inv.StatusCode);
    if (STATUS_CODES.length && !STATUS_CODES.includes(inv.StatusCode)) continue;
    for (const line of inv.Lines || []) {
      if (line.ModuleID == null) continue;
      feesToDate.set(line.ModuleID, (feesToDate.get(line.ModuleID) || 0) + (Number(line.Amount) || 0));
    }
  }

  // Forecasts: ModuleID → { 'YYYY-MM': amount }
  const forecastByModule = new Map();
  for (const f of forecasts) {
    if (f.ModuleID == null) continue;
    const key = monthKey(f.Date);
    if (!forecastByModule.has(f.ModuleID)) forecastByModule.set(f.ModuleID, {});
    const bucket = forecastByModule.get(f.ModuleID);
    bucket[key] = (bucket[key] || 0) + (Number(f.Amount) || 0);
  }

  const rows = modules.map((m) => {
    const p = projectById.get(m.ProjectID) || {};
    const fee = Number(m.Budget) || 0;
    const invoiced = feesToDate.get(m.ModuleID) || 0;
    // Two kinds of number, two sources. Services modules (Gross fees) show what
    // the customer plans to invoice, and Projectworks Forecasts is the field of
    // record. Non-services modules (Consultant fees) show subconsultant costs,
    // which live only in this app — reading them back from Projectworks would
    // return whatever the retired rollup last wrote and drift from the supplier
    // lines from the first edit onwards.
    const isServices = !!m.IsServices;
    const months = isServices
      ? (forecastByModule.get(m.ModuleID) || {})
      : moduleMonthTotals(supplierLines, m.ModuleID, inWindow);
    return {
      moduleID: m.ModuleID,
      stat: m.IsActive ? 'A' : 'I',
      isActive: !!m.IsActive,
      isServices,
      parentNumber: p.ProjectNumber || '',
      stageNumber: m.ExternalReference || '',
      projectID: m.ProjectID,
      projectName: p.ProjectName || m.Projectname || '',
      projectManagerName: p.ProjectManagerName || '',
      // Approximates BQE/Deltek's "Class" filter — not a literal field match.
      // Confirm against SJB's real tenant once migrated; Principal and
      // Originator have no Projectworks equivalent at all and are likely
      // tenant-specific custom fields, so they are not surfaced here.
      projectType: p.ProjectTypeName || '',
      stageName: m.ModuleName || '',
      fee,
      feesToDate: invoiced,
      remaining: fee - invoiced,
      months,
      // Which system owns `months`. The UI decides editability from this, not
      // from the active tab, so the two cannot drift apart.
      monthsSource: isServices ? 'projectworks' : 'store',
    };
  });

  rows.sort((a, b) =>
    String(a.parentNumber).localeCompare(String(b.parentNumber)) ||
    String(a.stageName).localeCompare(String(b.stageName))
  );

  return {
    rows,
    netRows: buildNetRows(rows, inWindow),
    supplierLines,
    meta: {
      projects: projects.length,
      modules: modules.length,
      invoices: invoices.length,
      forecastEntries: forecasts.length,
      invoiceStatusFilter: STATUS_CODES.length ? STATUS_CODES : 'ALL (unfiltered — confirm before demoing revenue figures)',
      invoiceStatusesSeen: [...statusesSeen].filter(Boolean),
      writesEnabled: ALLOW_WRITES,
      baseUrl: BASE_URL,
      tenant: RESOLVED_TENANT ? RESOLVED_TENANT.name : '',
    },
  };
}

const app = express();
app.use(requireBasicAuth); // first, so the static handler is gated too
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function writesBlocked(res) {
  if (ALLOW_WRITES) return false;
  res.status(403).json({
    error: 'Writes are disabled. Set ALLOW_WRITES=true in .env to enable edits.',
  });
  return true;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL,
    // Resolved from the API at boot and matched against PW_TENANT_LOCK, so the
    // header chip names the tenant instead of the host every tenant shares.
    tenant: RESOLVED_TENANT ? RESOLVED_TENANT.name : '',
    tenantOffices: RESOLVED_TENANT ? RESOLVED_TENANT.offices : [],
    authMode: AUTH_MODE,
    writesEnabled: ALLOW_WRITES,
    invoiceStatusFilter: STATUS_CODES,
    // false → Fees to Date sums every status, including drafts. The UI raises
    // a banner on this without waiting for a data load.
    invoiceStatusFiltered: STATUS_CODES.length > 0,
    appBaseUrl: APP_BASE_URL,
  });
});

app.get('/api/grid', async (req, res) => {
  const { start, end } = req.query;
  if (!/^\d{4}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}$/.test(end || '')) {
    return res.status(400).json({ error: 'start and end are required as YYYY-MM' });
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
  if (moduleID == null || !/^\d{4}-\d{2}$/.test(month || '') || amount == null || Number.isNaN(Number(amount))) {
    return res.status(400).json({ error: 'moduleID, month (YYYY-MM) and numeric amount are required' });
  }
  let auditUser;
  try {
    auditUser = await resolveSelectedAuditUser(req.body);
    // The only route that writes to Projectworks, so this is the only place the
    // consultant/services boundary has to hold. It fails closed.
    await assertServicesModule(moduleID);
  } catch (err) {
    return sendUserResolveError(res, err);
  }
  // User-selection based audit labeling for demo/internal use only. This is
  // not authenticated identity; secure attribution needs SSO or delegated auth.
  const ctx = context || {};
  const result = await pwSetForecast(
    moduleID, month, amount,
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
        moduleID,
        month,
        from: ctx.from ?? '',
        to: Number(amount),
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
    const lines = await storage.getSupplierLines(moduleID ? Number(moduleID) : undefined);
    res.json({ supplierLines: lines });
  } catch (err) {
    sendStoreError(res, err);
  }
});

app.post('/api/supplier-lines', async (req, res) => {
  if (writesBlocked(res)) return;
  const { moduleID, supplier, description, context } = req.body || {};
  if (moduleID == null || !supplier || !String(supplier).trim()) {
    return res.status(400).json({ error: 'moduleID and supplier are required' });
  }
  let auditUser;
  try {
    auditUser = await resolveSelectedAuditUser(req.body);
  } catch (err) {
    return sendUserResolveError(res, err);
  }
  const ctx = context || {};
  try {
    const line = await storage.transaction(async (tx) => {
      const created = await tx.createSupplierLine({
        moduleID: Number(moduleID),
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
  const id = Number(req.params.id);
  const { month, amount, context } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(month || '') || amount == null || Number.isNaN(Number(amount))) {
    return res.status(400).json({ error: 'month (YYYY-MM) and numeric amount are required' });
  }
  let auditUser;
  try {
    auditUser = await resolveSelectedAuditUser(req.body);
  } catch (err) {
    return sendUserResolveError(res, err);
  }
  const ctx = context || {};
  try {
    const out = await storage.transaction(async (tx) => {
      const changed = await tx.setSupplierLineMonth(id, month, Number(amount));
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
        to: Number(amount),
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
  const id = Number(req.params.id);
  const { context } = req.body || {};
  let auditUser;
  try {
    auditUser = await resolveSelectedAuditUser(req.body);
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
  const appBaseWarning = appBaseUrlTenantWarning(RESOLVED_TENANT.name);

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
      console.warn('  *  WARNING: AUTH_DISABLED=true — every route is open to anyone  *');
      console.warn('  *  who can reach this server, including the write endpoints.    *');
      console.warn('  *  Never set this on a hosted or public deployment.             *');
      console.warn('  ****************************************************************');
      console.warn('');
    }

    if (!STATUS_CODES.length) {
      console.warn('');
      console.warn('  ****************************************************************');
      console.warn('  *  WARNING: INVOICE_STATUS_CODES is not set.                    *');
      console.warn('  *  Fees to Date is UNFILTERED — it sums every invoice status,   *');
      console.warn('  *  including drafts and unapproved invoices, so the revenue     *');
      console.warn('  *  figures shown will be wrong. Set INVOICE_STATUS_CODES to     *');
      console.warn('  *  the approved status code(s) for this tenant before demoing.  *');
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
