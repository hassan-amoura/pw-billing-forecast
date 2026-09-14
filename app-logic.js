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

function aggregateInvoiceFees(invoices, allowedStatusCodes) {
  const allowed = new Set(allowedStatusCodes.map(String));
  const totalsByModule = new Map();
  const statusesSeen = new Set();

  for (const invoice of invoices) {
    const status = firstValue(invoice, ['StatusCode', 'statusCode']);
    if (status !== undefined && status !== null && String(status).trim()) statusesSeen.add(String(status));
    if (allowed.size && !allowed.has(String(status))) continue;
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
  const allowed = new Set(options.allowedStatusIDs.map(String));
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
    if (!allowed.has(String(status))) continue;

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

async function collectPages(fetchPage, options = {}) {
  const pageSize = options.pageSize || 200;
  const maxPages = options.maxPages || 100;
  const label = options.label || 'collection';
  const output = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchPage(page, pageSize);
    if (!Array.isArray(batch)) throw new Error(`${label} returned a non-array response; check the endpoint shape.`);
    output.push(...batch);
    if (batch.length < pageSize) return output;
  }
  throw new Error(`${label} hit the ${maxPages * pageSize}-record safety limit; refusing to show incomplete data.`);
}

module.exports = {
  aggregateExpenseActuals,
  aggregateForecasts,
  aggregateInvoiceFees,
  buildNetRows,
  collectPages,
  compareTenantOfficeNames,
  firstValue,
  isMonth,
  moduleMonthTotals,
  normalizedLabel,
  resolveModuleCustomFields,
};
