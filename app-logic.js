'use strict';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function isMonth(value) {
  return MONTH_PATTERN.test(String(value || ''));
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object && Object.prototype.hasOwnProperty.call(object, key)) {
      const value = object[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

/** Comma-separated env list: trimmed, inner whitespace collapsed, empties dropped. */
function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedLabel(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Confirm every API-returned office name is in the configured allow-list. */
function compareTenantOfficeNames(expectedNames, actualNames) {
  const uniqueByNormalizedName = (values) => {
    const names = new Map();
    for (const value of values) {
      const display = String(value ?? '').trim().replace(/\s+/g, ' ');
      const normalized = normalizedLabel(display);
      if (normalized && !names.has(normalized)) names.set(normalized, display);
    }
    return names;
  };

  const expected = uniqueByNormalizedName(expectedNames);
  const actual = uniqueByNormalizedName(actualNames);
  const missing = [...expected.keys()].filter((name) => !actual.has(name)).map((name) => expected.get(name));
  const unexpected = [...actual.keys()].filter((name) => !expected.has(name)).map((name) => actual.get(name));

  return {
    matches: actual.size > 0 && unexpected.length === 0,
    matchedNames: [...expected.keys()].map((name) => actual.get(name)).filter(Boolean),
    missing,
    unexpected,
  };
}

function identityValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return String(value).trim();
}

function customFieldLabel(field) {
  return identityValue(firstValue(field, [
    '__configuredLabel', 'Label', 'label', 'FieldLabel', 'fieldLabel', 'Name', 'name',
  ]));
}

function customFieldID(field) {
  return identityValue(firstValue(field, [
    'FieldID', 'fieldID', 'fieldId', 'CustomFieldID', 'customFieldID',
    'customFieldId', 'ID', 'id',
  ]));
}

function customFieldEntityTypeID(field) {
  return identityValue(firstValue(field, [
    '__entityTypeID', 'EntityTypeID', 'entityTypeID', 'entityTypeId',
  ]));
}

function customFieldDisplayValue(field) {
  if (!field || typeof field !== 'object') return '';
  const multi = firstValue(field, ['MultiSelectValues', 'multiSelectValues']);
  if (Array.isArray(multi) && multi.length) {
    return multi.map((value) => String(value).trim()).filter(Boolean).join(', ');
  }
  const value = firstValue(field, ['Value', 'value']);
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Resolve configured module custom fields without assuming one undocumented
 * response shape. Live responses may identify values by label, by field ID,
 * or only by position. The positional path is intentionally restricted to
 * definitions for the configured module entity type.
 */
function resolveModuleCustomFields(module, definitions, configuredLabels, moduleEntityTypeID = '') {
  const entries = asArray(firstValue(module, ['CustomFields', 'customFields']));
  const allDefinitions = asArray(definitions);
  const entityType = identityValue(moduleEntityTypeID);
  const scopedDefinitions = entityType
    ? allDefinitions.filter((definition) => customFieldEntityTypeID(definition) === entityType)
    : allDefinitions;
  const values = {};
  const matched = new Set();
  let usedOrdinal = false;

  for (const configured of configuredLabels) {
    const key = configured.key;
    const wanted = normalizedLabel(configured.label);
    let entry = entries.find((candidate) => normalizedLabel(customFieldLabel(candidate)) === wanted);

    const definition = allDefinitions.find((candidate) => normalizedLabel(customFieldLabel(candidate)) === wanted);
    if (!entry && definition) {
      const wantedID = customFieldID(definition);
      if (wantedID) entry = entries.find((candidate) => customFieldID(candidate) === wantedID);
    }

    if (!entry && definition && entityType) {
      const position = scopedDefinitions.indexOf(definition);
      if (position >= 0 && position < entries.length) {
        entry = entries[position];
        usedOrdinal = true;
      }
    }

    const value = customFieldDisplayValue(entry);
    values[key] = value;
    if (entry) matched.add(key);
  }

  return { values, matched, usedOrdinal };
}

/**
 * A project is archived when Projectworks marks it inactive OR its workflow
 * status is one of the archived status names. Both signals are needed: the
 * swagger documents isActive, but SJB's tenant keeps IsActive=true on every
 * project and archives through ProjectStatusName "Archived" (2,766 of 3,685
 * projects, verified live 2026-10-20).
 */
function isArchivedProject(project, archivedStatusNames) {
  const active = firstValue(project, ['IsActive', 'isActive']);
  if (active === false || String(active).toLowerCase() === 'false') return true;
  const status = normalizedLabel(firstValue(project, ['ProjectStatusName', 'projectStatusName']));
  return !!status && asArray(archivedStatusNames).some((name) => normalizedLabel(name) === status);
}

/**
 * Projectworks expense claims carry only a numeric expenseClaimStatusID, and
 * the Open API has no endpoint that names those IDs (ExpenseClaims/Statuses
 * and similar return 404). Configured values may therefore be IDs, or names
 * that resolve through this table. Evidence for each entry is recorded here:
 *
 *   Approved → 4: every one of SJB's 13,297 live expense claims carried
 *   ExpenseClaimStatusID 4, and the SJB deployment ran EXPENSE_STATUS_CODES=4
 *   as its approved filter before the value was switched to the name.
 */
const KNOWN_EXPENSE_STATUS_IDS = new Map([['approved', '4']]);
const EXPENSE_STATUS_NAME_KEYS = ['ExpenseClaimStatusName', 'expenseClaimStatusName', 'StatusName', 'statusName'];

function resolveExpenseStatusFilter(configured) {
  const ids = new Set();
  const names = new Set();
  const resolved = [];
  for (const raw of asArray(configured)) {
    const value = String(raw).trim();
    if (!value) continue;
    if (/^\d+$/.test(value)) {
      ids.add(value);
      resolved.push({ configured: value, id: value, source: 'id' });
      continue;
    }
    const key = normalizedLabel(value);
    names.add(key);
    const known = KNOWN_EXPENSE_STATUS_IDS.get(key);
    if (known) {
      ids.add(known);
      resolved.push({ configured: value, id: known, source: 'built-in' });
    } else {
      resolved.push({ configured: value, id: null, source: 'name-field' });
    }
  }
  return { ids, names, resolved };
}

/** True when a claim's status is in the resolved filter (by ID, or by a name field if the API sends one). */
function expenseStatusAllowed(claim, filter) {
  const id = firstValue(claim, ['ExpenseClaimStatusID', 'expenseClaimStatusID']);
  if (id !== undefined && id !== null && filter.ids.has(String(id).trim())) return true;
  const name = normalizedLabel(firstValue(claim, EXPENSE_STATUS_NAME_KEYS));
  return !!name && filter.names.has(name);
}

/** Invoice statuses match on StatusCode text (case/space-insensitive) or a numeric StatusID. */
function invoiceStatusMatcher(allowedStatusCodes) {
  const allowed = new Set(allowedStatusCodes.map(normalizedLabel));
  return (invoice) => !allowed.size ||
    allowed.has(normalizedLabel(firstValue(invoice, ['StatusCode', 'statusCode']))) ||
    allowed.has(normalizedLabel(firstValue(invoice, ['StatusID', 'statusID'])));
}

function aggregateInvoiceFees(invoices, allowedStatusCodes) {
  const matches = invoiceStatusMatcher(allowedStatusCodes);
  const totalsByModule = new Map();
  const statusesSeen = new Set();

  for (const invoice of invoices) {
    const status = firstValue(invoice, ['StatusCode', 'statusCode']);
    if (status !== undefined && status !== null && String(status).trim()) statusesSeen.add(String(status));
    if (!matches(invoice)) continue;
    for (const line of asArray(firstValue(invoice, ['Lines', 'lines']))) {
      const moduleID = firstValue(line, ['ModuleID', 'moduleID']);
      if (moduleID === undefined || moduleID === null) continue;
      const amount = Number(firstValue(line, ['Amount', 'amount']));
      if (!Number.isFinite(amount)) continue;
      totalsByModule.set(String(moduleID), (totalsByModule.get(String(moduleID)) || 0) + amount);
    }
  }

  return { totalsByModule, statusesSeen };
}

/**
 * What Gross Fees to Date will be built from: how many invoices arrived, the
 * distinct statuses on them (raw, with counts), and how many pass
 * INVOICE_STATUS_CODES under the same rule aggregateInvoiceFees applies.
 */
function summarizeInvoiceStatuses(invoices, allowedStatusCodes) {
  const matches = invoiceStatusMatcher(allowedStatusCodes);
  const counts = new Map();
  let matched = 0;
  for (const invoice of asArray(invoices)) {
    const code = firstValue(invoice, ['StatusCode', 'statusCode']);
    const id = firstValue(invoice, ['StatusID', 'statusID']);
    const key = code !== undefined && String(code).trim() !== ''
      ? `"${code}"${id !== undefined ? ` (StatusID ${id})` : ''}`
      : (id !== undefined ? `StatusID ${id}` : '(no status)');
    counts.set(key, (counts.get(key) || 0) + 1);
    if (matches(invoice)) matched += 1;
  }
  return {
    total: asArray(invoices).length,
    matched,
    statuses: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

function aggregateExpenseActuals(expenseClaims, options) {
  const filter = options.statusFilter || resolveExpenseStatusFilter(options.allowedStatusIDs);
  const moduleProject = options.moduleProject;
  const projectCurrency = options.projectCurrency;
  const asOfDate = String(options.asOfDate);
  const totalsByModule = new Map();
  const monthsByModule = new Map();
  const statusesSeen = new Set();
  const currencyIssuesByModule = new Map();
  let plannedExcluded = 0;
  let futureExcluded = 0;
  let missingModule = 0;
  let missingAmount = 0;
  let missingDate = 0;

  for (const claim of expenseClaims) {
    const status = firstValue(claim, ['ExpenseClaimStatusID', 'expenseClaimStatusID']);
    if (status !== undefined && status !== null && String(status).trim()) statusesSeen.add(String(status));
    if (!expenseStatusAllowed(claim, filter)) continue;

    const planned = firstValue(claim, ['IsPlanned', 'isPlanned']);
    if (planned === true || String(planned).toLowerCase() === 'true') {
      plannedExcluded += 1;
      continue;
    }

    const date = String(firstValue(claim, ['Date', 'date']) || '');
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
      missingDate += 1;
      continue;
    }
    if (date.slice(0, 10) > asOfDate) {
      futureExcluded += 1;
      continue;
    }

    const moduleIDValue = firstValue(claim, ['ModuleID', 'moduleID']);
    if (moduleIDValue === undefined || moduleIDValue === null || String(moduleIDValue).trim() === '') {
      missingModule += 1;
      continue;
    }
    const moduleID = String(moduleIDValue);
    const amountValue = firstValue(claim, ['AmountWithoutTax', 'amountWithoutTax']);
    if (amountValue === undefined || amountValue === null || String(amountValue).trim() === '') {
      missingAmount += 1;
      continue;
    }
    const amount = Number(amountValue);
    if (!Number.isFinite(amount)) {
      missingAmount += 1;
      continue;
    }

    const projectID = moduleProject.get(moduleID);
    const expectedCurrencyID = identityValue(projectCurrency.get(String(projectID)));
    const actualCurrencyID = identityValue(firstValue(claim, ['CurrencyID', 'currencyID']));
    if (!expectedCurrencyID || !actualCurrencyID || expectedCurrencyID !== actualCurrencyID) {
      const current = currencyIssuesByModule.get(moduleID) || { count: 0, amount: 0 };
      current.count += 1;
      current.amount += amount;
      currencyIssuesByModule.set(moduleID, current);
      continue;
    }

    totalsByModule.set(moduleID, (totalsByModule.get(moduleID) || 0) + amount);
    const month = date.slice(0, 7);
    if (isMonth(month)) {
      if (!monthsByModule.has(moduleID)) monthsByModule.set(moduleID, {});
      const bucket = monthsByModule.get(moduleID);
      bucket[month] = (bucket[month] || 0) + amount;
    }
  }

  return {
    totalsByModule,
    monthsByModule,
    statusesSeen,
    statusFilter: filter,
    currencyIssuesByModule,
    plannedExcluded,
    futureExcluded,
    missingModule,
    missingAmount,
    missingDate,
  };
}

function aggregateForecasts(forecasts) {
  const byModule = new Map();
  for (const forecast of forecasts) {
    const moduleID = firstValue(forecast, ['ModuleID', 'moduleID']);
    if (moduleID === undefined || moduleID === null) continue;
    const date = String(firstValue(forecast, ['Date', 'date']) || '');
    const month = date.slice(0, 7);
    if (!isMonth(month)) continue;
    const amount = Number(firstValue(forecast, ['Amount', 'amount']));
    if (!Number.isFinite(amount)) continue;
    const key = String(moduleID);
    if (!byModule.has(key)) byModule.set(key, {});
    const bucket = byModule.get(key);
    bucket[month] = (bucket[month] || 0) + amount;
  }
  return byModule;
}

function moduleMonthTotals(supplierLines, moduleID, withinMonths) {
  const out = {};
  for (const line of supplierLines.filter((candidate) => candidate.moduleID === moduleID)) {
    for (const [month, value] of Object.entries(line.months || {})) {
      if (withinMonths && !withinMonths(month)) continue;
      out[month] = (out[month] || 0) + (Number(value) || 0);
    }
  }
  return out;
}

function buildNetRows(rows, inWindow) {
  const byProject = new Map();
  const addDistinct = (list, value) => {
    const text = String(value || '').trim();
    if (text && !list.includes(text)) list.push(text);
  };

  for (const row of rows) {
    let net = byProject.get(row.projectID);
    if (!net) {
      net = {
        projectID: row.projectID,
        parentNumber: row.parentNumber,
        projectName: row.projectName || `Project ${row.projectID}`,
        projectManagerName: row.projectManagerName,
        projectType: row.projectType,
        currencyID: row.currencyID,
        currencyCode: row.currencyCode,
        stageNumbers: [],
        riskStatuses: [],
        fixedHourlies: [],
        isActive: false,
        servicesStages: 0,
        consultantStages: 0,
        plannedMonths: {},
        consultantMonths: {},
        months: {},
      };
      byProject.set(row.projectID, net);
    }
    if (row.isActive) net.isActive = true;
    if (row.isServices) net.servicesStages += 1; else net.consultantStages += 1;
    addDistinct(net.stageNumbers, row.stageNumber);
    addDistinct(net.riskStatuses, row.riskStatus);
    addDistinct(net.fixedHourlies, row.fixedHourly);

    const bucket = row.isServices ? net.plannedMonths : net.consultantMonths;
    for (const [month, value] of Object.entries(row.months || {})) {
      if (!inWindow(month)) continue;
      bucket[month] = (bucket[month] || 0) + (Number(value) || 0);
    }
  }

  const output = [];
  for (const net of byProject.values()) {
    const plannedKeys = Object.keys(net.plannedMonths);
    const consultantKeys = Object.keys(net.consultantMonths);
    if (!plannedKeys.length && !consultantKeys.length) continue;

    for (const month of new Set([...plannedKeys, ...consultantKeys])) {
      net.months[month] = (net.plannedMonths[month] || 0) - (net.consultantMonths[month] || 0);
    }
    const total = (object) => Object.values(object).reduce((sum, value) => sum + (Number(value) || 0), 0);
    net.plannedTotal = total(net.plannedMonths);
    net.consultantTotal = total(net.consultantMonths);
    net.netTotal = net.plannedTotal - net.consultantTotal;
    net.stageNumber = net.stageNumbers.join(' · ');
    net.riskStatus = net.riskStatuses.join(' · ');
    net.fixedHourly = net.fixedHourlies.join(' · ');
    delete net.stageNumbers;
    delete net.riskStatuses;
    delete net.fixedHourlies;
    output.push(net);
  }

  output.sort((a, b) =>
    String(a.projectName).localeCompare(String(b.projectName), undefined, { numeric: true, sensitivity: 'base' }) ||
    String(a.parentNumber).localeCompare(String(b.parentNumber), undefined, { numeric: true, sensitivity: 'base' })
  );
  return output;
}

/**
 * The module IDs a project record lists. The live /Projects response carries
 * `Modules` as a plain array of ModuleIDs (verified 2026-10-20: 27,779 across
 * SJB's 3,685 projects, equal to /Modules' x-total-count), which makes it the
 * exact expected set per project. Object entries are read for their ModuleID.
 * Returns null when the record carries no Modules array at all.
 */
function projectModuleIDs(project) {
  const embedded = firstValue(project, ['ModuleIDs', 'Modules', 'modules']);
  if (!Array.isArray(embedded)) return null;
  return embedded
    .map((entry) => (entry && typeof entry === 'object' ? firstValue(entry, ['ModuleID', 'moduleID']) : entry))
    .filter((id) => id !== undefined && id !== null && id !== '')
    .map(String);
}

/**
 * Read the modules of each project with one GET /Modules?ProjectID= per
 * project, `concurrency` at a time.
 *
 * The bulk /Modules read is unusable: the API sorts by ModuleName with nothing
 * to break ties and honours no sort parameter, so offset pages overlap and gap
 * differently on every request. A project's modules fit on one page (the
 * largest SJB project has well under 1,000), so a per-project read is not
 * exposed to that at all.
 *
 * A project is complete when its read met x-total-count, every row belongs to
 * the project (an ignored filter cannot pass off another project's modules),
 * and every ModuleID the project record lists arrived. An incomplete or failed
 * read is retried up to `attempts` times in total; the transport already
 * backs off on 429/5xx inside each attempt.
 *
 * @param {object} args
 * @param {object[]} args.projects
 * @param {(projectID: string) => Promise<{ rows: object[], report: { complete: boolean, total: number|null } }>} args.fetchProjectModules
 * @param {number} [args.concurrency=10]
 * @param {number} [args.attempts=3]
 * @param {({ done: number, total: number }) => void} [args.onProgress]
 * @param {(info: { projectID: string, attempt: number, reason: string }) => void} [args.onRetry]
 * @returns {Promise<{ modules: object[], results: { projectID: string, modules: number, total: number|null,
 *   attempts: number, complete: boolean, reason?: string }[],
 *   failed: { projectID: string, reason: string, partial: object[] }[] }>}
 *   `modules` holds complete projects only; a failed project's last rows are in
 *   its `partial`, for the caller to use or replace.
 */
async function fetchModulesByProject({ projects, fetchProjectModules, concurrency = 10, attempts = 3, onProgress, onRetry }) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const retried = typeof onRetry === 'function' ? onRetry : () => {};
  const idOf = (m) => String(firstValue(m, ['ModuleID', 'moduleID']));
  const queue = projects.map((project) => ({ projectID: String(firstValue(project, ['ProjectID', 'projectID'])), project }));
  const results = new Array(queue.length);
  let done = 0;
  progress({ done, total: queue.length });

  async function readOne({ projectID, project }) {
    const expected = projectModuleIDs(project);
    let last = { projectID, modules: 0, total: null, attempts: 0, complete: false, reason: 'not read', rows: [] };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let reason = '';
      let rows = [];
      let total = null;
      try {
        const read = await fetchProjectModules(projectID);
        total = read.report ? read.report.total : null;
        rows = (read.rows || []).filter((row) => String(firstValue(row, ['ProjectID', 'projectID'])) === projectID);
        const foreign = (read.rows || []).length - rows.length;
        const got = new Set(rows.map(idOf));
        const unlisted = expected ? expected.filter((id) => !got.has(id)).length : 0;
        if (foreign) reason = `${foreign} row(s) for another project`;
        else if (!read.report || !read.report.complete) reason = `fetched ${got.size} of x-total-count ${total}`;
        else if (unlisted) reason = `${unlisted} listed module(s) missing`;
      } catch (err) {
        reason = String((err && err.message) || err);
      }
      last = { projectID, modules: rows.length, total, attempts: attempt, complete: !reason, rows, ...(reason ? { reason } : {}) };
      if (!reason) break;
      if (attempt < attempts) retried({ projectID, attempt, reason });
    }
    return last;
  }

  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (next < queue.length) {
      const index = next;
      next += 1;
      results[index] = await readOne(queue[index]);
      done += 1;
      progress({ done, total: queue.length });
    }
  });
  await Promise.all(workers);

  const modules = [];
  const failed = [];
  for (const result of results) {
    if (result.complete) modules.push(...result.rows);
    else failed.push({ projectID: result.projectID, reason: result.reason, partial: result.rows });
    delete result.rows;
  }
  return { modules, results, failed };
}

/**
 * Incremental refresh: apply the modules changed since the last sync to the
 * cached set, then decide which projects still need a full per-project read.
 *
 * `projects` is the complete, current list of ACTIVE projects (read in full on
 * every refresh: it is four pages, and each record lists its ModuleIDs, which
 * is what reveals deleted modules and projects that became active). A changed
 * module on a project that is not active is ignored. For each active project:
 *   - a cached module no longer listed is dropped (deleted in Projectworks);
 *   - a listed module that is not cached, or a project new to the active set
 *     without a module list, sends the project to `toFetch`.
 *
 * @returns {{ modules: object[], toFetch: string[], removed: number, updated: number }}
 */
function mergeModuleChanges({ projects, previousProjectIDs, previousModules, changedModules }) {
  const idOf = (m) => String(firstValue(m, ['ModuleID', 'moduleID']));
  const projectOf = (r) => String(firstValue(r, ['ProjectID', 'projectID']));
  const active = new Map(projects.map((p) => [projectOf(p), p]));
  const byID = new Map();
  for (const m of previousModules) if (active.has(projectOf(m))) byID.set(idOf(m), m);
  let updated = 0;
  for (const m of changedModules) {
    const id = idOf(m);
    if (active.has(projectOf(m))) {
      byID.set(id, m);
      updated += 1;
    } else {
      byID.delete(id); // moved to, or still on, a project that is not active
    }
  }

  const byProject = new Map();
  for (const m of byID.values()) {
    const key = projectOf(m);
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(m);
  }
  const known = new Set([...previousProjectIDs].map(String));
  const modules = [];
  const toFetch = [];
  let removed = 0;
  for (const [projectID, project] of active) {
    const cached = byProject.get(projectID) || [];
    const listed = projectModuleIDs(project);
    if (!listed) {
      if (!known.has(projectID)) toFetch.push(projectID);
      else modules.push(...cached);
      continue;
    }
    const listedSet = new Set(listed);
    const kept = cached.filter((m) => listedSet.has(idOf(m)));
    removed += cached.length - kept.length;
    if (kept.length < listedSet.size) toFetch.push(projectID);
    else modules.push(...kept);
  }
  return { modules, toFetch, removed, updated };
}

module.exports = {
  aggregateExpenseActuals,
  aggregateForecasts,
  aggregateInvoiceFees,
  summarizeInvoiceStatuses,
  buildNetRows,
  compareTenantOfficeNames,
  expenseStatusAllowed,
  firstValue,
  isArchivedProject,
  isMonth,
  moduleMonthTotals,
  normalizedLabel,
  parseList,
  fetchModulesByProject,
  mergeModuleChanges,
  projectModuleIDs,
  resolveExpenseStatusFilter,
  resolveModuleCustomFields,
};
