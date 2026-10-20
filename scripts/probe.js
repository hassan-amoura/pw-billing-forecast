#!/usr/bin/env node
/**
 * READ-ONLY tenant probe. Sends GET requests only and prints aggregate counts
 * and field shapes — never credentials, never client or project names.
 *
 *   PROBE_ENV=.env.prod node scripts/probe.js
 *
 * PROBE_ENV is a path relative to the repo root (default .env). It answers the
 * go-live questions: are pages complete, what does isActive=false leave, which
 * offices carry projects (the tenant lock must allow every one), and does the
 * "Stage No" module custom field resolve by label.
 */
'use strict';

const path = require('path');
const REPO = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(REPO, process.env.PROBE_ENV || '.env') });

const BASE = String(process.env.PW_BASE_URL || '').replace(/\/+$/, '');
const headers = { Accept: 'application/json' };
if ((process.env.AUTH_MODE || '').toLowerCase() === 'header') {
  headers[process.env.PW_AUTH_HEADER_NAME] = process.env.PW_AUTH_HEADER_VALUE;
} else {
  headers.Authorization = 'Basic ' + Buffer.from(`${process.env.PW_USERNAME}:${process.env.PW_PASSWORD}`).toString('base64');
}
const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
const LABELS = list(process.env.MODULE_CUSTOM_FIELD_LABELS);

async function get(p, params = {}) {
  const u = new URL(BASE + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const t = Date.now();
  const r = await fetch(u, { headers });
  if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
  return { body: await r.json(), total: r.headers.get('x-total-count'), pages: r.headers.get('x-page-count'), ms: Date.now() - t };
}

async function all(p, params = {}, size = 1000) {
  const first = await get(p, { ...params, page: 1, pageSize: size });
  const pages = Number(first.pages) || 1;
  const out = [...first.body];
  const rest = [];
  for (let pg = 2; pg <= pages; pg++) rest.push(pg);
  while (rest.length) {
    const batch = await Promise.all(rest.splice(0, 6).map((pg) => get(p, { ...params, page: pg, pageSize: size })));
    for (const b of batch) out.push(...b.body);
  }
  const complete = first.total == null ? 'no x-total-count header' : (out.length === Number(first.total) ? 'complete' : `INCOMPLETE ${out.length}/${first.total}`);
  return { rows: out, total: first.total, pages: first.pages, complete };
}

const pick = (o, ks) => { for (const k of ks) if (o && o[k] !== undefined) return o[k]; };
const tally = (rows, fn) => rows.reduce((m, r) => { const k = String(fn(r)); m[k] = (m[k] || 0) + 1; return m; }, {});
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

(async () => {
  console.log('API host:', new URL(BASE).host, '| PW_TENANT_LOCK:', JSON.stringify(list(process.env.PW_TENANT_LOCK)));

  console.log('\n--- 1. page caps / headers');
  for (const p of ['/api/v1/Projects', '/api/v1/Modules', '/api/v1/Invoices', '/api/v1/ExpenseClaims', '/api/v1/Offices']) {
    for (const size of [1000, 2000]) {
      const r = await get(p, { page: 1, pageSize: size });
      console.log(p, `pageSize=${size} → returned ${r.body.length}, x-total-count=${r.total}, x-page-count=${r.pages}, ${r.ms}ms`);
    }
  }

  console.log('\n--- 2. projects, offices, tenant lock');
  const projects = await all('/api/v1/Projects');
  console.log(`projects: ${projects.rows.length} (header ${projects.total}) ${projects.complete}`);
  console.log('project IsActive:', tally(projects.rows, (p) => pick(p, ['IsActive', 'isActive'])));
  console.log('ProjectStatusName × IsActive:', tally(projects.rows, (p) => `${pick(p, ['ProjectStatusName', 'projectStatusName'])} | active=${pick(p, ['IsActive', 'isActive'])}`));
  const officeTally = tally(projects.rows, (p) => `${pick(p, ['OfficeName', 'officeName'])} (${pick(p, ['OfficeID', 'officeID'])})`);
  console.log('projects by OfficeName (OfficeID):', officeTally);
  const offices = await all('/api/v1/Offices');
  console.log('Offices:', JSON.stringify(offices.rows.map((o) => ({ id: pick(o, ['OfficeID', 'officeID']), name: pick(o, ['Name', 'name']), active: pick(o, ['IsActive', 'isActive']) }))), offices.complete);
  const lock = new Set(list(process.env.PW_TENANT_LOCK).map(norm));
  const projectOffices = [...new Set(projects.rows.map((p) => pick(p, ['OfficeName', 'officeName'])).filter(Boolean))];
  const outside = projectOffices.filter((name) => !lock.has(norm(name)));
  console.log(outside.length
    ? `TENANT LOCK WOULD REFUSE TO START: project office(s) outside PW_TENANT_LOCK: ${JSON.stringify(outside)}`
    : 'tenant lock: every project office is inside PW_TENANT_LOCK');

  console.log('\n--- 3. modules');
  const t1 = Date.now();
  const modules = await all('/api/v1/Modules', { IncludeCustomFields: true });
  console.log(`modules: ${modules.rows.length} (header ${modules.total}, pages ${modules.pages}) ${modules.complete} in ${Date.now() - t1}ms (6 pages in parallel)`);
  const activeProject = new Map(projects.rows.map((p) => [String(pick(p, ['ProjectID', 'projectID'])), !!pick(p, ['IsActive', 'isActive'])]));
  console.log('modules by project IsActive:', tally(modules.rows, (m) => activeProject.get(String(pick(m, ['ProjectID', 'projectID'])))));
  console.log('modules by project active × module active × services:', tally(modules.rows, (m) =>
    `proj=${activeProject.get(String(pick(m, ['ProjectID', 'projectID'])))} mod=${pick(m, ['IsActive', 'isActive'])} svc=${pick(m, ['IsServices', 'isServices'])}`));
  const byID = [...modules.rows].sort((a, b) => Number(pick(a, ['ModuleID', 'moduleID'])) - Number(pick(b, ['ModuleID', 'moduleID'])));
  const first20k = modules.rows.slice(0, 20000);
  const isGrossDefault = (m) => pick(m, ['IsServices', 'isServices']) && pick(m, ['IsActive', 'isActive']);
  console.log('17,955 check — first 20,000 modules in API order, services && module IsActive:', first20k.filter(isGrossDefault).length);
  console.log('                 same, first 20,000 by ModuleID:', byID.slice(0, 20000).filter(isGrossDefault).length);
  console.log('                 same, all modules:', modules.rows.filter(isGrossDefault).length);
  console.log('API order is ascending ModuleID:', modules.rows.every((m, i) => i === 0 || Number(pick(m, ['ModuleID', 'moduleID'])) > Number(pick(modules.rows[i - 1], ['ModuleID', 'moduleID']))));

  console.log('\n--- 4. module custom fields');
  const entries = modules.rows.flatMap((m) => pick(m, ['CustomFields', 'customFields']) || []);
  console.log('custom-field entry key sets:', tally(entries, (c) => Object.keys(c).sort().join(',')));
  for (const label of LABELS) {
    const hits = entries.filter((c) => norm(pick(c, ['Label', 'label'])) === norm(label));
    const filled = hits.filter((c) => String(pick(c, ['Value', 'value']) ?? '').trim() || (pick(c, ['MultiSelectValues', 'multiSelectValues']) || []).length);
    console.log(`label "${label}": on ${hits.length} module(s), value set on ${filled.length}; FieldIDs ${JSON.stringify([...new Set(hits.map((c) => pick(c, ['FieldID', 'fieldID'])))])}`);
  }
  const sample = modules.rows.find((m) => (pick(m, ['CustomFields', 'customFields']) || []).some((c) => pick(c, ['Value', 'value'])));
  if (sample) console.log('sample entry (values redacted):', JSON.stringify((pick(sample, ['CustomFields', 'customFields']) || [])[0], (k, v) => (k === 'Value' || k === 'value') && v ? '<value>' : v));

  console.log('\n--- 5. status codes');
  const invoices = await all('/api/v1/Invoices');
  console.log(`invoices: ${invoices.rows.length} ${invoices.complete}; StatusCode tally:`, tally(invoices.rows, (i) => pick(i, ['StatusCode', 'statusCode'])));
  const claims = await all('/api/v1/ExpenseClaims', { IncludeCustomFields: false });
  console.log(`expense claims: ${claims.rows.length} ${claims.complete}; status-ish fields:`,
    tally(claims.rows, (c) => Object.entries(c).filter(([k]) => /status/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' ')));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
