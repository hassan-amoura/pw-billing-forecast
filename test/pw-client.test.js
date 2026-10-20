'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectworksClient, IncompleteCollectionError } = require('../pw-client');

/**
 * A fake Projectworks collection endpoint. `cap` mimics the API's silent
 * pageSize ceiling; headers are computed on the size actually served, the way
 * the live API does it.
 */
function fakeApi(records, { cap = 1000, headers = true, dropPage = null, calls = [] } = {}) {
  return async (url) => {
    const page = Number(url.searchParams.get('page')) || 1;
    const size = Math.min(Number(url.searchParams.get('pageSize')) || cap, cap);
    calls.push(page);
    let body = records.slice((page - 1) * size, page * size);
    if (page === dropPage) body = body.slice(1);
    const h = new Headers({ 'content-type': 'application/json' });
    if (headers) {
      h.set('x-total-count', String(records.length));
      h.set('x-page-count', String(Math.ceil(records.length / size)));
    }
    return new Response(JSON.stringify(body), { status: 200, headers: h });
  };
}

const records = (n) => Array.from({ length: n }, (_, i) => ({ ModuleID: i + 1 }));
const client = (fetchImpl) => createProjectworksClient({
  baseUrl: 'http://pw.test',
  authHeaders: () => ({}),
  timeoutMs: 1000,
  pageSize: 1000,
  fetchImpl,
  retryDelayMs: 1,
});

test('pages come from x-page-count, so an API cap below the requested size does not truncate', async () => {
  // The API serves 750 per page when asked for 1000. Treating that short first
  // page as the last one would have dropped 20,250 of 21,000 records.
  const calls = [];
  const rows = await client(fakeApi(records(21000), { cap: 750, calls })).getAll('/api/v1/Modules', {}, { idKeys: ['ModuleID'] });
  assert.equal(rows.length, 21000);
  assert.equal(new Set(rows.map((r) => r.ModuleID)).size, 21000);
  assert.equal(calls.length, 28);
});

test('a fetched count that disagrees with x-total-count is reported and refused', async () => {
  const pw = client(fakeApi(records(2500), { dropPage: 2 }));
  const { rows, report } = await pw.getAllWithReport('/api/v1/Modules', {}, { idKeys: ['ModuleID'] });
  assert.equal(rows.length, 2499);
  assert.equal(report.complete, false);
  assert.equal(report.total, 2500);
  await assert.rejects(pw.getAll('/api/v1/Modules', {}, { idKeys: ['ModuleID'] }), IncompleteCollectionError);
});

test('without pagination headers, paging continues past short pages until an empty page', async () => {
  const pw = client(fakeApi(records(2300), { headers: false, cap: 1000 }));
  const { rows, report } = await pw.getAllWithReport('/api/v1/Offices', {});
  assert.equal(rows.length, 2300);
  assert.equal(report.verifiedBy, 'empty-page');
});

test('an endpoint that ignores page and repeats itself stops instead of looping', async () => {
  const fetchImpl = async () => new Response(JSON.stringify([{ OfficeID: 1 }, { OfficeID: 2 }]), { status: 200 });
  const rows = await client(fetchImpl).getAll('/api/v1/Offices', {}, { noPageSize: true });
  assert.equal(rows.length, 2);
});

test('transient upstream failures are retried', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) return new Response('busy', { status: 503 });
    return new Response('[]', { status: 200, headers: { 'x-total-count': '0', 'x-page-count': '0' } });
  };
  assert.deepEqual(await client(fetchImpl).getAll('/api/v1/Invoices'), []);
  assert.equal(attempts, 2);
});

/**
 * Pages listed in `shifted` are served `by` records early for their first
 * `times` requests: the page repeats the tail of the page before it and drops
 * the same number of records from its own end — the way an unstable sort
 * moves records across offset boundaries under concurrent paging.
 */
function shiftingApi(all, { cap = 1000, shifted = [], by = 64, times = 1, calls = [] } = {}) {
  const served = new Map();
  return async (url) => {
    const page = Number(url.searchParams.get('page')) || 1;
    const size = Math.min(Number(url.searchParams.get('pageSize')) || cap, cap);
    calls.push(page);
    const n = (served.get(page) || 0) + 1;
    served.set(page, n);
    const offset = shifted.includes(page) && n <= times ? by : 0;
    const body = all.slice((page - 1) * size - offset, page * size - offset);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'x-total-count': String(all.length), 'x-page-count': String(Math.ceil(all.length / size)) },
    });
  };
}

test('records that shift between pages are deduplicated and the missing ones re-fetched', async () => {
  // Two shifted pages × 64 = 128 duplicated and 128 missing, as seen in production.
  const calls = [];
  const pw = client(shiftingApi(records(27779), { shifted: [3, 7], calls }));
  const { rows, report } = await pw.getAllWithReport('/api/v1/Modules', {}, { idKeys: ['ModuleID'] });
  assert.equal(report.duplicates, 128);
  assert.equal(report.unique, 27779);
  assert.equal(report.complete, true);
  assert.equal(report.recoveryPasses, 1);
  assert.equal(rows.length, 27779);
  assert.equal(new Set(rows.map((r) => r.ModuleID)).size, 27779);
  // 28 pages, then only the pages around the two shifted boundaries (1–4 and
  // 5–8) again; no sequential pass.
  assert.equal(calls.length, 28 + 8);
});

test('a shift that survives the targeted re-reads is settled by a sequential pass', async () => {
  const calls = [];
  const pw = client(shiftingApi(records(5000), { shifted: [3], times: 3, calls }));
  const { rows, report } = await pw.getAllWithReport('/api/v1/Modules', {}, { idKeys: ['ModuleID'] });
  assert.equal(report.complete, true);
  assert.equal(report.recoveryPasses, 3);
  assert.equal(rows.length, 5000);
});

test('a collection still short after recovery is reported incomplete, not padded', async () => {
  const pw = client(shiftingApi(records(5000), { shifted: [3], times: Infinity }));
  const { rows, report } = await pw.getAllWithReport('/api/v1/Modules', {}, { idKeys: ['ModuleID'] });
  assert.equal(report.complete, false);
  assert.equal(report.unique, 4936);
  assert.equal(rows.length, 4936);
  await assert.rejects(pw.getAll('/api/v1/Modules', {}, { idKeys: ['ModuleID'] }), IncompleteCollectionError);
});
