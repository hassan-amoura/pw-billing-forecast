'use strict';

/**
 * Projectworks Open API client: GETs with a bounded timeout, retries on
 * transient upstream failures, a global concurrency cap, and pagination that
 * is verified against the API's own counts.
 *
 * Pagination contract (verified live): every collection endpoint honours
 * page/pageSize, caps pageSize at 1000 whatever is requested, and reports
 * x-total-count and x-page-count computed on the page size it actually used.
 * A page shorter than the size asked for is therefore NOT proof of the last
 * page — an API-side cap below the requested size would make the first page
 * "short" and silently drop everything after it. Page count comes from the
 * headers only, and the result is checked against x-total-count.
 */

class IncompleteCollectionError extends Error {
  constructor(report) {
    super(
      `${report.label} is incomplete: fetched ${report.fetched} of ${report.total} records` +
      `${report.duplicates ? ` (${report.duplicates} duplicate IDs across pages)` : ''}. ` +
      'Refusing to treat a partial collection as complete.'
    );
    this.name = 'IncompleteCollectionError';
    this.report = report;
  }
}

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    next();
  });
}

function headerCount(headers, name) {
  const raw = headers.get(name);
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function idOf(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {() => object} options.authHeaders
 * @param {number} options.timeoutMs
 * @param {number} [options.pageSize=1000]       largest page the API honours
 * @param {number} [options.pageConcurrency=6]   pages of one collection in flight
 * @param {number} [options.maxConcurrent=12]    requests in flight across the app
 * @param {number} [options.maxPages=200]        hard stop: 200,000 records
 * @param {number} [options.retries=2]
 * @param {Function} [options.fetchImpl=fetch]
 */
function createProjectworksClient(options) {
  const baseUrl = String(options.baseUrl).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs;
  const pageSize = options.pageSize || 1000;
  const pageConcurrency = options.pageConcurrency || 6;
  const maxPages = options.maxPages || 200;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 400;
  const fetchImpl = options.fetchImpl || fetch;
  const limit = createLimiter(options.maxConcurrent || 12);

  async function requestOnce(pathname, params) {
    const url = new URL(baseUrl + pathname);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { Accept: 'application/json', ...options.authHeaders() },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const wrapped = new Error(
        `GET ${pathname} ${timedOut ? `timed out after ${timeoutMs}ms` : `failed: ${String(err.message || err)}`}`
      );
      wrapped.retryable = true;
      throw wrapped;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`GET ${pathname} → ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
      err.status = res.status;
      err.retryable = RETRYABLE_STATUS.has(res.status);
      err.retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || 0;
      throw err;
    }
    return {
      body: await res.json(),
      total: headerCount(res.headers, 'x-total-count'),
      pageCount: headerCount(res.headers, 'x-page-count'),
    };
  }

  /** One GET, through the global limiter, retried on transient failures. */
  async function request(pathname, params = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await limit(() => requestOnce(pathname, params));
      } catch (err) {
        if (!err.retryable || attempt >= retries) throw err;
        await sleep(Math.max(err.retryAfterMs || 0, retryDelayMs * (attempt + 1)));
      }
    }
  }

  async function get(pathname, params = {}) {
    return (await request(pathname, params)).body;
  }

  async function fetchCollectionOnce(pathname, params, opts) {
    const label = opts.label || `GET ${pathname}`;
    const size = opts.pageSize || pageSize;
    const map = opts.map || ((row) => row);
    const pageParams = (page) => ({ ...params, page, ...(opts.noPageSize ? {} : { pageSize: size }) });

    const first = await request(pathname, pageParams(1));
    if (!Array.isArray(first.body)) {
      throw new Error(`${label} returned a non-array response; check the endpoint shape.`);
    }
    const pages = [first.body.map(map)];
    let total = first.total;
    let pageCount = first.pageCount;
    let verifiedBy = 'headers';

    if (pageCount === null && total !== null) {
      // Derive the page count from the size the API actually used.
      pageCount = total === 0 ? 0 : Math.ceil(total / Math.max(first.body.length, 1));
    }

    if (pageCount !== null) {
      if (pageCount > maxPages) {
        throw new Error(`${label} reports ${pageCount} pages, over the ${maxPages}-page safety limit; refusing to show incomplete data.`);
      }
      const rest = [];
      for (let page = 2; page <= pageCount; page += 1) rest.push(page);
      const pageLimit = createLimiter(pageConcurrency);
      const fetched = await Promise.all(rest.map((page) => pageLimit(async () => {
        const res = await request(pathname, pageParams(page));
        if (!Array.isArray(res.body)) throw new Error(`${label} page ${page} returned a non-array response.`);
        if (res.total !== null && total !== null && res.total !== total) total = Math.max(total, res.total);
        return res.body.map(map);
      })));
      pages.push(...fetched);
    } else {
      // No pagination headers at all (e.g. /Offices). Keep paging until an
      // EMPTY page, never stopping on a merely short one, and stop if the API
      // ignores `page` and repeats itself.
      verifiedBy = 'empty-page';
      let previous = JSON.stringify(first.body);
      for (let page = 2; first.body.length && page <= maxPages + 1; page += 1) {
        if (page > maxPages) throw new Error(`${label} hit the ${maxPages}-page safety limit; refusing to show incomplete data.`);
        const res = await request(pathname, pageParams(page));
        if (!Array.isArray(res.body) || !res.body.length) break;
        const signature = JSON.stringify(res.body);
        if (signature === previous) break;
        previous = signature;
        pages.push(res.body.map(map));
      }
    }

    const rows = pages.flat();
    let duplicates = 0;
    if (opts.idKeys) {
      const seen = new Set();
      for (const row of rows) {
        const id = idOf(row, opts.idKeys);
        if (id === null) continue;
        if (seen.has(id)) duplicates += 1;
        else seen.add(id);
      }
    }
    const unique = rows.length - duplicates;
    const report = {
      label,
      fetched: rows.length,
      unique,
      duplicates,
      total,
      pages: pages.length,
      verifiedBy,
      complete: total === null ? true : (unique === total && duplicates === 0),
    };
    return { rows, report };
  }

  /**
   * Every record of a collection, with a completeness report. A mismatch is
   * retried once (records created mid-read shift page boundaries); a second
   * mismatch is returned as complete:false for the caller to surface.
   */
  async function getAllWithReport(pathname, params = {}, opts = {}) {
    let result = await fetchCollectionOnce(pathname, params, opts);
    if (!result.report.complete) result = await fetchCollectionOnce(pathname, params, opts);
    return result;
  }

  /** Every record of a collection; throws IncompleteCollectionError on a short read. */
  async function getAll(pathname, params = {}, opts = {}) {
    const { rows, report } = await getAllWithReport(pathname, params, opts);
    if (!report.complete) throw new IncompleteCollectionError(report);
    return rows;
  }

  return { get, request, getAll, getAllWithReport };
}

module.exports = { createProjectworksClient, createLimiter, IncompleteCollectionError };
