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
