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
function aggregateInvoiceFees(invoices, allowedStatusCodes) {
  const allowed = new Set(allowedStatusCodes.map(normalizedLabel));
  const totalsByModule = new Map();
  const statusesSeen = new Set();

  for (const invoice of invoices) {
    const status = firstValue(invoice, ['StatusCode', 'statusCode']);
    const statusID = firstValue(invoice, ['StatusID', 'statusID']);
    if (status !== undefined && status !== null && String(status).trim()) statusesSeen.add(String(status));
    if (allowed.size && !allowed.has(normalizedLabel(status)) && !allowed.has(normalizedLabel(statusID))) continue;
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

module.exports = {
  aggregateExpenseActuals,
  aggregateForecasts,
  aggregateInvoiceFees,
  buildNetRows,
  compareTenantOfficeNames,
  expenseStatusAllowed,
  firstValue,
  isArchivedProject,
  isMonth,
  moduleMonthTotals,
  normalizedLabel,
  parseList,
  resolveExpenseStatusFilter,
  resolveModuleCustomFields,
};
