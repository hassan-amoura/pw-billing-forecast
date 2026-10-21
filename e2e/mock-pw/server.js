'use strict';

/**
 * Mock Projectworks Open API for end-to-end tests. Never talks to a real
 * tenant. Mirrors the live API's observable behaviour:
 *   - HTTP Basic auth, PascalCase JSON arrays
 *   - page/pageSize with a silent server-side page-size cap, and
 *     x-total-count / x-page-count computed on the size actually served
 *   - /Offices: no pageSize parameter and no pagination headers
 *   - POST /Forecasts/Set upserts one module-month and is recorded
 *
 * The cap is 750 here (the live API caps at 1000) so that a client which
 * treated a short page as the last page would truncate at 750 records.
 *
 *   - ModifiedDateUTC on projects and modules, and ModifiedSinceDate on
 *     /Projects and /Modules (records modified at or after it), as live
 *
 * Control endpoints (no auth): GET /__mock/health, GET /__mock/forecast-sets,
 * POST /__mock/reset, and:
 *   POST /__mock/unstable?on=1 — /Modules sorts by ModuleName, as the live API
 *     does, and breaks the (many) ties at random on EVERY request.
 *   POST /__mock/hide?modules=1,2 — those modules are counted in
 *     x-total-count but never served, by any /Modules query, ProjectID
 *     included: a gap no re-read can fill.
 *   POST /__mock/short?projects=1&times=1 — the next `times` reads of each
 *     listed project's modules drop one row while still counting it.
 *   POST /__mock/fail?projects=1,2&status=500&times=2 — the next `times`
 *     reads of those projects' modules answer `status` (times=always: every).
 *   POST /__mock/outage?on=1 — every /api/v1 GET answers 503.
 *   POST /__mock/touch?module=ID&name=New%20name — rename a module and bump
 *     its ModifiedDateUTC, as an edit in Projectworks does.
 *   POST /__mock/delete?module=ID — delete a module (and drop it from its
 *     project's Modules list, bumping the project's ModifiedDateUTC).
 *   POST /__mock/delay?ms=800 — every /Modules response waits this long.
 *   GET  /__mock/requests — /Modules requests by kind since reset, with every
 *     ProjectID requested.
 */

const http = require('http');
const { buildFixtures } = require('./fixtures');

const PORT = Number(process.env.MOCK_PW_PORT || 4310);
const USER = process.env.MOCK_PW_USERNAME || 'e2e-key';
const PASS = process.env.MOCK_PW_PASSWORD || 'e2e-secret';
const PAGE_CAP = 750;

let data;
let forecastSets;
let unstable;
let hidden; // Set of ModuleIDs counted but never served
let delayMs;
let requests;
let failures; // ProjectID -> { status, times }
let shortReads; // ProjectID -> remaining short reads
let outage;
function reset() {
  data = buildFixtures();
  forecastSets = [];
  unstable = false;
  hidden = new Set();
  delayMs = 0;
  failures = new Map();
  shortReads = new Map();
  outage = false;
  requests = { modulesPaged: 0, modulesByProject: 0, modulesByID: 0, modulesModifiedSince: 0, projectIDs: [] };
}
const nowUTC = () => new Date().toISOString().replace('Z', '');
reset();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function paginate(res, rows, query, { headers = true, pageSizeParam = true, phantom = 0 } = {}) {
  const page = Math.max(1, Number(query.get('page')) || 1);
  const requested = pageSizeParam ? Number(query.get('pageSize')) || 100 : 100;
  const size = Math.min(requested, PAGE_CAP);
  const body = rows.slice((page - 1) * size, page * size);
  // `phantom` records are counted but never served (see /__mock/hide).
  const total = rows.length + phantom;
  const extra = headers
    ? { 'x-total-count': String(total), 'x-page-count': String(Math.ceil(total / size)) }
    : {};
  send(res, 200, body, extra);
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const day = (v) => String(v || '').slice(0, 10);
// ModifiedDateUTC has no zone suffix on the live API; it is UTC.
const modifiedSince = (q) => {
  const raw = q.get('ModifiedSinceDate');
  if (!raw) return () => true;
  const since = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
  return (record) => Date.parse(`${record.ModifiedDateUTC}Z`) >= since;
};

function handleGet(res, path, q) {
  switch (path) {
    case '/api/v1/Projects': {
      const id = num(q.get('ProjectID'));
      const changed = modifiedSince(q);
      return paginate(res, data.projects.filter((p) => (id === null || p.ProjectID === id) && changed(p)), q);
    }
    case '/api/v1/Modules': {
      const projectID = num(q.get('ProjectID'));
      const moduleID = num(q.get('ModuleID'));
      const changed = modifiedSince(q);
      const withFields = String(q.get('IncludeCustomFields')).toLowerCase() === 'true';
      const kind = moduleID !== null ? 'modulesByID'
        : (projectID !== null ? 'modulesByProject' : (q.get('ModifiedSinceDate') ? 'modulesModifiedSince' : 'modulesPaged'));
      requests[kind] += 1;
      if (projectID !== null) {
        requests.projectIDs.push(projectID);
        const failure = failures.get(projectID);
        if (failure && failure.times > 0) {
          failure.times -= 1;
          return send(res, failure.status, { error: 'mock: injected failure' });
        }
      }
      let rows = data.modules
        .filter((m) => (projectID === null || m.ProjectID === projectID) && (moduleID === null || m.ModuleID === moduleID) && changed(m));
      if (unstable) {
        rows = rows
          .map((m) => ({ m, tie: Math.random() }))
          .sort((a, b) => a.m.ModuleName.localeCompare(b.m.ModuleName) || a.tie - b.tie)
          .map(({ m }) => m);
      }
      let served = rows.filter((m) => !hidden.has(m.ModuleID)).map((m) => (withFields ? m : { ...m, CustomFields: [] }));
      if (projectID !== null && (shortReads.get(projectID) || 0) > 0) {
        shortReads.set(projectID, shortReads.get(projectID) - 1);
        served = served.slice(1);
      }
      const respond = () => paginate(res, served, q, { phantom: rows.length - served.length });
      if (delayMs) return void setTimeout(respond, delayMs);
      return respond();
    }
    case '/api/v1/Invoices':
      return paginate(res, data.invoices, q);
    case '/api/v1/ExpenseClaims': {
      const end = day(q.get('EndDate'));
      return paginate(res, data.expenseClaims.filter((c) => !end || day(c.Date) <= end), q);
    }
    case '/api/v1/Forecasts': {
      const moduleID = num(q.get('ModuleID'));
      const start = day(q.get('StartDate'));
      const end = day(q.get('EndDate'));
      return paginate(res, data.forecasts.filter((f) =>
        (moduleID === null || f.ModuleID === moduleID) &&
        (!start || day(f.Date) >= start) && (!end || day(f.Date) <= end)), q);
    }
    case '/api/v1/Offices':
      return paginate(res, data.offices, q, { headers: false, pageSizeParam: false });
    case '/api/v1/Users':
      return paginate(res, data.users, q);
    case '/api/v1/CustomFields/EntityTypes':
      return send(res, 200, [{ EntityTypeID: 1, Name: 'Project' }, { EntityTypeID: 4, Name: 'Project Budget' }]);
    case '/api/v1/CustomFields': {
      const label = String(q.get('Label') || '').toLowerCase();
      const defs = [
        { FieldID: 3, Label: 'Des / Del', EntityTypeID: 4, TypeName: 'Select' },
        { FieldID: 18, Label: 'Stage No', EntityTypeID: 4, TypeName: 'Text' },
        { FieldID: 19, Label: 'Risk Status', EntityTypeID: 4, TypeName: 'Select' },
      ];
      return paginate(res, defs.filter((d) => !label || d.Label.toLowerCase() === label), q);
    }
    default:
      return send(res, 404, { error: `mock: no route ${path}` });
  }
}

function setForecast(body) {
  const moduleID = Number(body.moduleID ?? body.ModuleID);
  const date = day(body.date ?? body.Date);
  const amount = Number(body.amount ?? body.Amount);
  const module = data.modules.find((m) => m.ModuleID === moduleID);
  if (!module || !/^\d{4}-\d{2}-01$/.test(date) || !Number.isFinite(amount)) return null;
  const existing = data.forecasts.find((f) => f.ModuleID === moduleID && day(f.Date) === date);
  if (existing) existing.Amount = amount;
  else data.forecasts.push({ ForecastID: Date.now(), ModuleID: moduleID, ProjectID: module.ProjectID, Date: `${date}T00:00:00`, Amount: amount });
  return { ModuleID: moduleID, Date: `${date}T00:00:00`, Amount: amount };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/__mock/health') return send(res, 200, { ok: true, expected: data.expected, named: data.named });
  if (url.pathname === '/__mock/forecast-sets') return send(res, 200, forecastSets);
  if (url.pathname === '/__mock/reset' && req.method === 'POST') { reset(); return send(res, 200, { ok: true }); }
  if (url.pathname === '/__mock/requests') return send(res, 200, requests);
  if (url.pathname === '/__mock/unstable' && req.method === 'POST') {
    unstable = url.searchParams.get('on') !== '0';
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/hide' && req.method === 'POST') {
    hidden = new Set(String(url.searchParams.get('modules') || '').split(',').filter(Boolean).map(Number));
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/delay' && req.method === 'POST') {
    delayMs = Number(url.searchParams.get('ms')) || 0;
    return send(res, 200, { ok: true });
  }
  const ids = (name) => String(url.searchParams.get(name) || '').split(',').filter(Boolean).map(Number);
  const times = () => (url.searchParams.get('times') === 'always' ? Infinity : Number(url.searchParams.get('times')) || 1);
  if (url.pathname === '/__mock/short' && req.method === 'POST') {
    for (const id of ids('projects')) shortReads.set(id, times());
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/fail' && req.method === 'POST') {
    const status = Number(url.searchParams.get('status')) || 500;
    for (const id of ids('projects')) failures.set(id, { status, times: times() });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/outage' && req.method === 'POST') {
    outage = url.searchParams.get('on') !== '0';
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/touch' && req.method === 'POST') {
    const module = data.modules.find((m) => m.ModuleID === Number(url.searchParams.get('module')));
    if (!module) return send(res, 404, { error: 'mock: no such module' });
    if (url.searchParams.get('name')) module.ModuleName = url.searchParams.get('name');
    module.ModifiedDateUTC = nowUTC();
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/delete' && req.method === 'POST') {
    const id = Number(url.searchParams.get('module'));
    const module = data.modules.find((m) => m.ModuleID === id);
    if (!module) return send(res, 404, { error: 'mock: no such module' });
    data.modules = data.modules.filter((m) => m !== module);
    const project = data.projects.find((p) => p.ProjectID === module.ProjectID);
    project.Modules = project.Modules.filter((m) => m !== id);
    project.ModifiedDateUTC = nowUTC();
    return send(res, 200, { ok: true });
  }

  const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  if (req.headers.authorization !== expected) return send(res, 401, { error: 'mock: bad credentials' });

  if (req.method === 'GET') {
    if (outage) return send(res, 503, { error: 'mock: outage' });
    return handleGet(res, url.pathname, url.searchParams);
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/Forecasts/Set') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'mock: invalid JSON' }); }
      forecastSets.push(body);
      const saved = setForecast(body);
      return saved ? send(res, 200, saved) : send(res, 400, { error: 'mock: invalid forecast' });
    });
    return undefined;
  }
  return send(res, 405, { error: 'mock: method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock Projectworks API on http://127.0.0.1:${PORT} — ${data.modules.length} modules, ${data.projects.length} projects`);
});
