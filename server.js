/**
 * pw-billing-forecast — server
 *
 * A thin server with two jobs:
 *   1. Serve the static grid UI (public/index.html)
 *   2. Hold the Projectworks Open API credentials and proxy a small,
 *      fixed set of calls. The browser never sees the credentials.
 *
 * Endpoints:
 *   GET  /api/health              — config sanity check for the UI
 *   GET  /api/users               — safe Projectworks user picker data
 *   GET  /api/grid?start&end      — { rows, supplierLines, meta }
 *   POST /api/forecast            — { moduleID, month:"YYYY-MM", amount, selectedProjectworksUserID, context }
 *                                   → POST /api/v1/Forecasts/Set
 *   GET  /api/supplier-lines      — app-side supplier lines (data/store.json)
 *   POST /api/supplier-lines      — { moduleID, supplier, selectedProjectworksUserID, context }
 *   PUT  /api/supplier-lines/:id/month — { month, amount, selectedProjectworksUserID, context }
 *                                   sets the line's month cell, then rolls the
 *                                   module's month total up to Projectworks
 *   DELETE /api/supplier-lines/:id
 *   GET  /api/audit               — newest audit entries (max 100)
 *
 * All mutations (forecast AND supplier-line) are blocked unless
 * ALLOW_WRITES=true.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BASE_URL = (process.env.PW_BASE_URL || '').replace(/\/+$/, '');
const APP_BASE_URL = (process.env.PW_APP_BASE_URL || '').replace(/\/+$/, '');
const AUTH_MODE = (process.env.AUTH_MODE || '').toLowerCase();
const TENANT_LOCK = (process.env.PW_TENANT_LOCK || '').trim();
const ALLOW_WRITES = process.env.ALLOW_WRITES === 'true';
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
if (missingConfig.length) refuseToStart(missingConfig);

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
// Projectworks has no supplier grain in forecasts, so supplier lines live
// here; the module-level rollup is what syncs to Projectworks.
// data/ is not committed and a redeploy wipes it, so the store self-heals from
// the committed seed.json at the project root.
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const SEED_PATH = path.join(__dirname, 'seed.json');

/** Normalise a parsed store so a truncated or hand-edited file can't crash a route. */
function normalizeStore(raw) {
  const supplierLines = Array.isArray(raw?.supplierLines) ? raw.supplierLines : [];
  const audit = Array.isArray(raw?.audit) ? raw.audit : [];
  const maxID = supplierLines.reduce((m, l) => Math.max(m, Number(l?.id) || 0), 0);
  const declared = Number(raw?.nextLineID) || 0;
  return { nextLineID: Math.max(declared, maxID + 1), supplierLines, audit };
}

function readStoreFile() {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')));
  } catch {
    return null;
  }
}

/** A fresh store from seed.json. Supplier lines are seeded; the audit never is. */
function seededStore() {
  try {
    const seed = normalizeStore(JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')));
    return { nextLineID: seed.nextLineID, supplierLines: seed.supplierLines, audit: [] };
  } catch (err) {
    console.warn(`seed.json could not be read (${err.message}); starting from an empty store.`);
    return { nextLineID: 1, supplierLines: [], audit: [] };
  }
}

function loadStore() {
  return readStoreFile() || seededStore();
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

/**
 * Boot-time store initialisation. A store that already has supplier lines is
 * left exactly as it is; anything else (missing file, unreadable file, or an
 * empty supplierLines array) is rebuilt from seed.json. An audit log that
 * survived a reseed is kept — seed.json never contributes audit entries.
 */
function initStore() {
  const existing = readStoreFile();
  if (existing && existing.supplierLines.length) {
    console.log(`  Store:     data/store.json kept (${existing.supplierLines.length} supplier lines, ${existing.audit.length} audit entries)`);
    return;
  }
  const seeded = seededStore();
  if (existing) seeded.audit = existing.audit;
  saveStore(seeded);
  console.log(`  Store:     seeded from seed.json (${seeded.supplierLines.length} supplier lines, ${seeded.audit.length} audit entries)`);
}

function addAudit(store, entry) {
  store.audit.push({ time: new Date().toISOString(), ...entry });
  if (store.audit.length > 5000) store.audit = store.audit.slice(-5000);
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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
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

/**
 * POST /api/v1/Forecasts/Set for one module-month. Returns { ok, error }.
 * `comment` lands in the forecast change history in the Projectworks UI;
 * the Open API only writes it (GET /Forecasts never returns it).
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
  // Fetch the four collections in parallel. Forecasts are date-bounded to
  // the requested window; the rest are full pulls (fees to date is all-time).
  // The live API returns PascalCase fields (ModuleID, Budget, IsServices, …)
  // — verified against the sandbox tenant, not the swagger's casing.
  const forecastStart = `${startMonth}-01`;
  const [projects, modules, invoices, forecasts] = await Promise.all([
    pwGetAll('/api/v1/Projects'),
    pwGetAll('/api/v1/Modules'),
    pwGetAll('/api/v1/Invoices'),
    pwGetAll('/api/v1/Forecasts', { StartDate: forecastStart, EndDate: `${endMonth}-28` }),
  ]);

  const projectById = new Map(projects.map((p) => [p.ProjectID, p]));

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
    return {
      moduleID: m.ModuleID,
      stat: m.IsActive ? 'A' : 'I',
      isActive: !!m.IsActive,
      isServices: !!m.IsServices,
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
      months: forecastByModule.get(m.ModuleID) || {},
    };
  });

  rows.sort((a, b) =>
    String(a.parentNumber).localeCompare(String(b.parentNumber)) ||
    String(a.stageName).localeCompare(String(b.stageName))
  );

  const store = loadStore();

  return {
    rows,
    supplierLines: store.supplierLines,
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
  const store = loadStore();
  addAudit(store, {
    user: auditUser.name,
    projectworksUserID: auditUser.id,
    action: 'forecast.set',
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
  saveStore(store);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ ok: true });
});

// ---- supplier lines --------------------------------------------------------

app.get('/api/supplier-lines', (req, res) => {
  const store = loadStore();
  const { moduleID } = req.query;
  const lines = moduleID
    ? store.supplierLines.filter((l) => l.moduleID === Number(moduleID))
    : store.supplierLines;
  res.json({ supplierLines: lines });
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
  const store = loadStore();
  const line = {
    id: store.nextLineID++,
    moduleID: Number(moduleID),
    supplier: String(supplier).trim(),
    description: description ? String(description) : '',
    months: {},
  };
  store.supplierLines.push(line);
  addAudit(store, {
    user: auditUser.name,
    projectworksUserID: auditUser.id,
    action: 'supplier.add',
    project: ctx.project || '',
    stage: ctx.stage || '',
    supplier: line.supplier,
    moduleID: line.moduleID,
    month: '',
    from: '',
    to: '',
    synced: true, // app-side only; nothing to sync until a month cell is set
  });
  saveStore(store);
  res.json({ ok: true, line });
});

/**
 * Set one month cell on a supplier line, then roll the module's month total
 * (sum across its supplier lines) up to Projectworks. The local edit is kept
 * even if the rollup sync fails; the audit entry records synced=false.
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
  const store = loadStore();
  const line = store.supplierLines.find((l) => l.id === id);
  if (!line) return res.status(404).json({ error: `supplier line ${id} not found` });

  const from = line.months[month] ?? '';
  line.months[month] = Number(amount);

  const moduleTotal = store.supplierLines
    .filter((l) => l.moduleID === line.moduleID)
    .reduce((s, l) => s + (Number(l.months[month]) || 0), 0);

  const result = await pwSetForecast(
    line.moduleID, month, moduleTotal,
    `Set by ${auditUser.name} via PW Billing Forecast tool`
  );

  addAudit(store, {
    user: auditUser.name,
    projectworksUserID: auditUser.id,
    action: 'supplier.set',
    project: ctx.project || '',
    stage: ctx.stage || '',
    supplier: line.supplier,
    moduleID: line.moduleID,
    month,
    from,
    to: Number(amount),
    synced: true, // the supplier cell itself is app-side; the rollup entry carries sync state
  });
  addAudit(store, {
    user: auditUser.name,
    projectworksUserID: auditUser.id,
    action: 'rollup.set',
    project: ctx.project || '',
    stage: ctx.stage || '',
    supplier: '',
    moduleID: line.moduleID,
    month,
    from: ctx.moduleFrom ?? '',
    to: moduleTotal,
    synced: result.ok,
    ...(result.ok ? {} : { error: result.error }),
  });
  saveStore(store);

  res.json({ ok: true, moduleTotal, syncedToProjectworks: result.ok, ...(result.ok ? {} : { syncError: result.error }) });
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
  const store = loadStore();
  const idx = store.supplierLines.findIndex((l) => l.id === id);
  if (idx === -1) return res.status(404).json({ error: `supplier line ${id} not found` });
  const [line] = store.supplierLines.splice(idx, 1);

  // Re-sync every month the removed line touched so Projectworks totals drop.
  let allSynced = true;
  let lastError;
  for (const month of Object.keys(line.months)) {
    const moduleTotal = store.supplierLines
      .filter((l) => l.moduleID === line.moduleID)
      .reduce((s, l) => s + (Number(l.months[month]) || 0), 0);
    const result = await pwSetForecast(
      line.moduleID, month, moduleTotal,
      `Set by ${auditUser.name} via PW Billing Forecast tool`
    );
    if (!result.ok) { allSynced = false; lastError = result.error; }
  }

  addAudit(store, {
    user: auditUser.name,
    projectworksUserID: auditUser.id,
    action: 'supplier.delete',
    project: ctx.project || '',
    stage: ctx.stage || '',
    supplier: line.supplier,
    moduleID: line.moduleID,
    month: '',
    from: '',
    to: '',
    synced: allSynced,
    ...(allSynced ? {} : { error: lastError }),
  });
  saveStore(store);
  res.json({ ok: true });
});

// ---- audit -----------------------------------------------------------------

app.get('/api/audit', (_req, res) => {
  const store = loadStore();
  res.json({ audit: store.audit.slice(-100).reverse() });
});

// ---- boot ------------------------------------------------------------------

// The tenant lock is resolved from the API before the store is touched and
// before the server accepts a single request, so a wrong credential never gets
// to serve — or write — anything.
(async () => {
  RESOLVED_TENANT = await enforceTenantLock();
  initStore();
  const appBaseWarning = appBaseUrlTenantWarning(RESOLVED_TENANT.name);

  app.listen(PORT, HOST, () => {
    console.log(`pw-billing-forecast listening on ${HOST}:${PORT}`);
    console.log(`  Tenant:    ${RESOLVED_TENANT.name} (matches PW_TENANT_LOCK)`);
    console.log(`  API base:  ${BASE_URL}`);
    console.log(`  Auth mode: ${AUTH_MODE}`);
    console.log(`  Writes:    ${ALLOW_WRITES ? 'ENABLED' : 'disabled (read-only)'}`);
    console.log(`  Gate:      ${AUTH_DISABLED ? 'DISABLED' : `HTTP Basic (user "${BASIC_AUTH_USER}")`}`);

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
  // enforceTenantLock() exits on every failure it knows about; anything landing
  // here is unexpected, and still must not start a server of unknown tenancy.
  refuseToStart([
    'The tenant lock check failed unexpectedly and the tenant is unconfirmed:',
    '',
    `  ${String(err && err.stack ? err.stack : err)}`,
  ]);
});
