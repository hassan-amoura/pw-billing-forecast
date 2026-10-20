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
 * Control endpoints (no auth): GET /__mock/health, GET /__mock/forecast-sets,
 * POST /__mock/reset.
 */

const http = require('http');
const { buildFixtures } = require('./fixtures');

const PORT = Number(process.env.MOCK_PW_PORT || 4310);
const USER = process.env.MOCK_PW_USERNAME || 'e2e-key';
const PASS = process.env.MOCK_PW_PASSWORD || 'e2e-secret';
const PAGE_CAP = 750;

let data;
let forecastSets;
function reset() {
  data = buildFixtures();
  forecastSets = [];
}
reset();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function paginate(res, rows, query, { headers = true, pageSizeParam = true } = {}) {
  const page = Math.max(1, Number(query.get('page')) || 1);
  const requested = pageSizeParam ? Number(query.get('pageSize')) || 100 : 100;
  const size = Math.min(requested, PAGE_CAP);
  const body = rows.slice((page - 1) * size, page * size);
  const extra = headers
    ? { 'x-total-count': String(rows.length), 'x-page-count': String(Math.ceil(rows.length / size)) }
    : {};
  send(res, 200, body, extra);
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const day = (v) => String(v || '').slice(0, 10);

function handleGet(res, path, q) {
  switch (path) {
    case '/api/v1/Projects': {
      const id = num(q.get('ProjectID'));
      return paginate(res, data.projects.filter((p) => id === null || p.ProjectID === id), q);
    }
    case '/api/v1/Modules': {
      const projectID = num(q.get('ProjectID'));
      const moduleID = num(q.get('ModuleID'));
      const withFields = String(q.get('IncludeCustomFields')).toLowerCase() === 'true';
      const rows = data.modules
        .filter((m) => (projectID === null || m.ProjectID === projectID) && (moduleID === null || m.ModuleID === moduleID))
        .map((m) => (withFields ? m : { ...m, CustomFields: [] }));
      return paginate(res, rows, q);
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

  const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  if (req.headers.authorization !== expected) return send(res, 401, { error: 'mock: bad credentials' });

  if (req.method === 'GET') return handleGet(res, url.pathname, url.searchParams);
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
