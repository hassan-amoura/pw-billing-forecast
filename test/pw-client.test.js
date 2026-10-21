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

test('records that shift between pages are deduplicated and the shortfall reported, with no page re-read', async () => {
  // Two shifted pages × 64 = 128 duplicated and 128 missing, as seen in
  // production. Re-reading pages over an unstable order reshuffles again and
  // cannot converge, so the client reads each page once and says what is short.
  const calls = [];
  const pw = client(shiftingApi(records(27779), { shifted: [3, 7], calls }));
  const { rows, report } = await pw.getAllWithReport('/api/v1/Modules', {}, { idKeys: ['ModuleID'] });
  assert.equal(report.duplicates, 128);
  assert.equal(report.unique, 27651);
  assert.equal(report.missing, 128);
  assert.equal(report.complete, false);
  assert.equal(rows.length, 27651);
  assert.equal(new Set(rows.map((r) => r.ModuleID)).size, 27651);
  assert.equal(calls.length, 28);
});

test('getAll refuses a short read', async () => {
  const pw = client(shiftingApi(records(5000), { shifted: [3], times: Infinity }));
  await assert.rejects(pw.getAll('/api/v1/Modules', {}, { idKeys: ['ModuleID'] }), IncompleteCollectionError);
});

test('page progress is reported as each page arrives', async () => {
  const seen = [];
  await client(fakeApi(records(4200))).getAllWithReport('/api/v1/Modules', {}, {
    idKeys: ['ModuleID'], onProgress: (p) => seen.push(`${p.pagesDone}/${p.pages}`),
  });
  assert.deepEqual(seen, ['1/5', '2/5', '3/5', '4/5', '5/5']);
});

test('429 and 500 are retried with exponential backoff, honouring Retry-After, and each retry is reported', async () => {
  const statuses = [429, 500, 200];
  const retries = [];
  const fetchImpl = async () => {
    const status = statuses.shift();
    return status === 200
      ? new Response(JSON.stringify([{ ModuleID: 1 }]), { status: 200, headers: { 'x-total-count': '1', 'x-page-count': '1' } })
      : new Response('busy', { status, headers: status === 429 ? { 'retry-after': '0' } : {} });
  };
  const pw = createProjectworksClient({
    baseUrl: 'http://pw.test', authHeaders: () => ({}), timeoutMs: 1000, fetchImpl, retryDelayMs: 4,
    onRetry: (r) => retries.push(r),
  });
  const rows = await pw.getAll('/api/v1/Modules', { ProjectID: 7 }, { idKeys: ['ModuleID'] });
  assert.equal(rows.length, 1);
  assert.deepEqual(retries.map((r) => r.attempt), [1, 2]);
  assert.match(retries[0].error, /429/);
  assert.match(retries[1].error, /500/);
  // Jittered within [base/2, base] of an exponentially growing base: 4ms, then 8ms.
  assert.ok(retries[0].delayMs >= 2 && retries[0].delayMs <= 4);
  assert.ok(retries[1].delayMs >= 4 && retries[1].delayMs <= 8);
});

test('a non-retryable 4xx fails at once', async () => {
  let calls = 0;
  const pw = createProjectworksClient({
    baseUrl: 'http://pw.test', authHeaders: () => ({}), timeoutMs: 1000, retryDelayMs: 1,
    fetchImpl: async () => { calls += 1; return new Response('nope', { status: 400 }); },
  });
  await assert.rejects(pw.get('/api/v1/Modules', {}), /400/);
  assert.equal(calls, 1);
});
