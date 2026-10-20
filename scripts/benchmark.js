#!/usr/bin/env node
/**
 * READ-ONLY load-time benchmark. GET requests only; prints timings and counts.
 *
 *   PROBE_ENV=.env.prod node scripts/benchmark.js
 *
 * 1. Before: the previous grid fetch — each collection paged sequentially at
 *    pageSize 1000, stopping at the first short page, all collections in
 *    parallel, custom-field definitions re-read on every load.
 * 2. After (cold): pw-client — pages from x-page-count, six at a time,
 *    verified against x-total-count; reference data loaded once.
 * 3. Module strategy: every module page then filter archived projects out,
 *    versus one /Modules?ProjectID= call per non-archived project.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', process.env.PROBE_ENV || '.env') });
const { createProjectworksClient } = require('../pw-client');
const { isArchivedProject, parseList } = require('../app-logic');

const BASE = String(process.env.PW_BASE_URL || '').replace(/\/+$/, '');
const authHeaders = () => ((process.env.AUTH_MODE || '').toLowerCase() === 'header'
  ? { [process.env.PW_AUTH_HEADER_NAME]: process.env.PW_AUTH_HEADER_VALUE }
  : { Authorization: 'Basic ' + Buffer.from(`${process.env.PW_USERNAME}:${process.env.PW_PASSWORD}`).toString('base64') });
const pw = createProjectworksClient({ baseUrl: BASE, authHeaders, timeoutMs: 60000, pageConcurrency: 6, maxConcurrent: 12 });
const ARCHIVED = parseList(process.env.ARCHIVED_PROJECT_STATUSES || 'Archived');

const today = new Date().toISOString().slice(0, 10);
const startMonth = today.slice(0, 7);
const end = new Date(); end.setUTCMonth(end.getUTCMonth() + 12, 0);
const window = { StartDate: `${startMonth}-01`, EndDate: end.toISOString().slice(0, 10) };

const COLLECTIONS = [
  ['/api/v1/Projects', {}],
  ['/api/v1/Modules', { IncludeCustomFields: true }],
  ['/api/v1/Invoices', {}],
  ['/api/v1/Forecasts', window],
  ['/api/v1/ExpenseClaims', { EndDate: `${today}T23:59:59.999Z`, IncludeCustomFields: false }],
];
const CUSTOM_FIELD_CALLS = [
  ['/api/v1/CustomFields/EntityTypes', null],
  ['/api/v1/CustomFields', {}],
  ...parseList(process.env.MODULE_CUSTOM_FIELD_LABELS).map((label) => ['/api/v1/CustomFields', { Label: label }]),
];

async function timed(label, fn) {
  const t = Date.now();
  const out = await fn();
  const ms = Date.now() - t;
  console.log(`${label.padEnd(58)} ${(ms / 1000).toFixed(2)}s`);
  return { out, ms };
}

/** The old client: sequential pages, stop on the first short page. */
async function oldGetAll(pathname, params) {
  const out = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = await pw.get(pathname, { ...params, page, pageSize: 1000 });
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

(async () => {
  console.log(`API host ${new URL(BASE).host}; forecast window ${window.StartDate}..${window.EndDate}\n`);

  const before = await timed('BEFORE: sequential pages, all collections in parallel', () => Promise.all([
    ...COLLECTIONS.map(([p, q]) => oldGetAll(p, q)),
    ...CUSTOM_FIELD_CALLS.map(([p, q]) => (q ? oldGetAll(p, q) : pw.get(p))),
  ]));
  const after = await timed('AFTER (cold): x-page-count, 6 pages in flight, verified', () => Promise.all([
    ...COLLECTIONS.map(([p, q]) => pw.getAllWithReport(p, q)),
    pw.getAll('/api/v1/Offices', {}, { noPageSize: true }),
    ...CUSTOM_FIELD_CALLS.map(([p, q]) => (q ? pw.getAll(p, q) : pw.get(p))),
  ]));
  COLLECTIONS.forEach(([p], i) => {
    const r = after.out[i].report;
    console.log(`   ${p.padEnd(24)} ${String(r.unique).padStart(6)} of ${String(r.total).padStart(6)} (${r.pages} pages) ${r.complete ? 'complete' : 'INCOMPLETE'}  [before: ${before.out[i].length}]`);
  });

  const projects = after.out[0].rows;
  const modules = after.out[1].rows;
  const live = projects.filter((p) => !isArchivedProject(p, ARCHIVED));
  const liveIDs = new Set(live.map((p) => String(p.ProjectID ?? p.projectID)));
  const keptModules = modules.filter((m) => liveIDs.has(String(m.ProjectID ?? m.projectID)));
  console.log(`\nprojects ${projects.length} (non-archived ${live.length}); modules ${modules.length} (on non-archived projects ${keptModules.length})\n`);

  const allPages = await timed('MODULES A: every page (28 x 1000, 6 in flight) + filter', async () => {
    const rows = await pw.getAll('/api/v1/Modules', { IncludeCustomFields: true });
    return rows.filter((m) => liveIDs.has(String(m.ProjectID ?? m.projectID))).length;
  });
  const perProject = await timed(`MODULES B: one call per non-archived project (${live.length}, 6 in flight)`, async () => {
    const { createLimiter } = require('../pw-client');
    const limit = createLimiter(6);
    const counts = await Promise.all(live.map((p) => limit(() =>
      pw.getAll('/api/v1/Modules', { ProjectID: p.ProjectID ?? p.projectID, IncludeCustomFields: true }).then((r) => r.length))));
    return counts.reduce((a, b) => a + b, 0);
  });
  console.log(`   A kept ${allPages.out} modules, B fetched ${perProject.out}; faster: ${allPages.ms <= perProject.ms ? 'A (all pages + filter)' : 'B (per project)'}`);
})().catch((err) => { console.error('ERR', err.message); process.exit(1); });
