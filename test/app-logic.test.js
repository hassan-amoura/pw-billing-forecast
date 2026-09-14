'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateExpenseActuals,
  aggregateForecasts,
  aggregateInvoiceFees,
  buildNetRows,
  collectPages,
  compareTenantOfficeNames,
  moduleMonthTotals,
  resolveModuleCustomFields,
} = require('../app-logic');

test('tenant office lock requires the complete office set regardless of case or order', () => {
  const exact = compareTenantOfficeNames(
    ['SJB MEL', 'SJB SYD'],
    ['sjb syd', '  SJB   MEL  ']
  );
  const incomplete = compareTenantOfficeNames(['SJB MEL', 'SJB SYD'], ['SJB MEL']);
  const extra = compareTenantOfficeNames(['SJB MEL', 'SJB SYD'], ['SJB MEL', 'SJB SYD', 'Other']);

  assert.equal(exact.matches, true);
  assert.deepEqual(exact.matchedNames, ['SJB MEL', 'sjb syd']);
  assert.deepEqual(incomplete.missing, ['SJB SYD']);
  assert.deepEqual(extra.unexpected, ['Other']);
});

const configuredFields = [
  { key: 'stageNumber', label: 'Stage Number' },
  { key: 'riskStatus', label: 'Risk Status' },
  { key: 'fixedHourly', label: 'Fixed / Hourly' },
];

test('consultant actuals use approved, non-planned, pre-tax expenses through the as-of date', () => {
  const claims = [
    { expenseClaimStatusID: 4, moduleID: 10, date: '2026-08-03T00:00:00Z', amountWithoutTax: 100, currencyID: 1, isPlanned: false },
    { ExpenseClaimStatusID: 4, ModuleID: 10, Date: '2026-08-10T00:00:00Z', AmountWithoutTax: 25, CurrencyID: 1, IsPlanned: false },
    { expenseClaimStatusID: 4, moduleID: 10, date: '2026-08-11T00:00:00Z', amountWithoutTax: 40, currencyID: 1, isPlanned: true },
    { expenseClaimStatusID: 3, moduleID: 10, date: '2026-08-12T00:00:00Z', amountWithoutTax: 50, currencyID: 1, isPlanned: false },
    { expenseClaimStatusID: 4, moduleID: 10, date: '2026-08-13T00:00:00Z', amountWithoutTax: 60, currencyID: 2, isPlanned: false },
    { expenseClaimStatusID: 4, moduleID: 10, date: '2026-10-01T00:00:00Z', amountWithoutTax: 70, currencyID: 1, isPlanned: false },
    { expenseClaimStatusID: 4, moduleID: null, date: '2026-08-14T00:00:00Z', amountWithoutTax: 80, currencyID: 1, isPlanned: false },
    { expenseClaimStatusID: 4, moduleID: 10, date: '2026-08-15T00:00:00Z', currencyID: 1, isPlanned: false },
    { expenseClaimStatusID: 4, moduleID: 10, amountWithoutTax: 90, currencyID: 1, isPlanned: false },
  ];
  const actuals = aggregateExpenseActuals(claims, {
    allowedStatusIDs: ['4'],
    moduleProject: new Map([['10', '100']]),
    projectCurrency: new Map([['100', 1]]),
    asOfDate: '2026-09-14',
  });

  assert.equal(actuals.totalsByModule.get('10'), 125);
  assert.deepEqual(actuals.monthsByModule.get('10'), { '2026-08': 125 });
  assert.equal(actuals.plannedExcluded, 1);
  assert.equal(actuals.futureExcluded, 1);
  assert.equal(actuals.missingModule, 1);
  assert.equal(actuals.missingAmount, 1);
  assert.equal(actuals.missingDate, 1);
  assert.deepEqual(actuals.currencyIssuesByModule.get('10'), { count: 1, amount: 60 });
  assert.deepEqual([...actuals.statusesSeen].sort(), ['3', '4']);
});

test('module custom fields resolve directly by labels and preserve multi-select values', () => {
  const result = resolveModuleCustomFields({
    customFields: [
      { label: 'Risk Status', value: 'Amber' },
      { label: 'Stage Number', value: 'S-120' },
      { label: 'Fixed / Hourly', multiSelectValues: ['Fixed', 'Hourly'] },
    ],
  }, [], configuredFields);

  assert.deepEqual(result.values, {
    stageNumber: 'S-120',
    riskStatus: 'Amber',
    fixedHourly: 'Fixed, Hourly',
  });
  assert.equal(result.usedOrdinal, false);
});

test('module custom fields resolve by field ID through definitions', () => {
  const definitions = [
    { fieldID: 11, label: 'Stage Number' },
    { fieldID: 12, label: 'Risk Status' },
    { fieldID: 13, label: 'Fixed / Hourly' },
  ];
  const result = resolveModuleCustomFields({
    CustomFields: [
      { FieldID: 12, Value: 'High' },
      { FieldID: 13, Value: 'Hourly' },
      { FieldID: 11, Value: '02.04' },
    ],
  }, definitions, configuredFields);

  assert.deepEqual(result.values, {
    stageNumber: '02.04',
    riskStatus: 'High',
    fixedHourly: 'Hourly',
  });
});

test('identityless custom fields use ordinal mapping only with the configured module entity type', () => {
  const definitions = [
    { fieldID: 1, entityTypeID: 8, label: 'Stage Number' },
    { fieldID: 2, entityTypeID: 8, label: 'Risk Status' },
    { fieldID: 3, entityTypeID: 8, label: 'Fixed / Hourly' },
  ];
  const module = { customFields: [{ value: 'A-01' }, { value: 'Low' }, { value: 'Fixed' }] };
  const withoutEntityType = resolveModuleCustomFields(module, definitions, configuredFields);
  const withEntityType = resolveModuleCustomFields(module, definitions, configuredFields, '8');

  assert.deepEqual(withoutEntityType.values, { stageNumber: '', riskStatus: '', fixedHourly: '' });
  assert.deepEqual(withEntityType.values, { stageNumber: 'A-01', riskStatus: 'Low', fixedHourly: 'Fixed' });
  assert.equal(withEntityType.usedOrdinal, true);
});

test('invoice and forecast aggregations accept documented camelCase and observed PascalCase', () => {
  const invoices = aggregateInvoiceFees([
    { statusCode: 'Approved', lines: [{ moduleID: 10, amount: 80 }] },
    { StatusCode: 'Approved', Lines: [{ ModuleID: 10, Amount: 20 }] },
    { StatusCode: 'Draft', Lines: [{ ModuleID: 10, Amount: 500 }] },
  ], ['Approved']);
  const forecasts = aggregateForecasts([
    { moduleID: 10, date: '2026-08-01', amount: 30 },
    { ModuleID: 10, Date: '2026-08-01', Amount: 40 },
  ]);

  assert.equal(invoices.totalsByModule.get('10'), 100);
  assert.deepEqual(forecasts.get('10'), { '2026-08': 70 });
});

test('consultant planning rolls up supplier lines only inside the selected window', () => {
  const totals = moduleMonthTotals([
    { moduleID: 10, months: { '2026-07': 25, '2026-08': 50 } },
    { moduleID: 10, months: { '2026-08': 20 } },
    { moduleID: 11, months: { '2026-08': 900 } },
  ], 10, (month) => month === '2026-08');

  assert.deepEqual(totals, { '2026-08': 70 });
});

test('net position subtracts consultant planning and preserves distinct stage metadata', () => {
  const rows = [
    {
      projectID: 1, parentNumber: 'P-1', projectName: 'Alpha', projectManagerName: 'PM', projectType: 'Type',
      currencyID: 1, currencyCode: 'AUD', stageNumber: '01', riskStatus: 'Low', fixedHourly: 'Fixed',
      isActive: true, isServices: true, months: { '2026-08': 100, '2027-01': 500 },
    },
    {
      projectID: 1, parentNumber: 'P-1', projectName: 'Alpha', projectManagerName: 'PM', projectType: 'Type',
      currencyID: 1, currencyCode: 'AUD', stageNumber: '02', riskStatus: 'High', fixedHourly: 'Hourly',
      isActive: true, isServices: false, months: { '2026-08': 35 },
    },
    {
      projectID: 2, parentNumber: 'P-2', projectName: 'Empty', projectManagerName: 'PM', projectType: 'Type',
      currencyID: 1, currencyCode: 'AUD', stageNumber: '', riskStatus: '', fixedHourly: '',
      isActive: true, isServices: true, months: {},
    },
  ];

  const net = buildNetRows(rows, (month) => month === '2026-08');
  assert.equal(net.length, 1);
  assert.equal(net[0].plannedTotal, 100);
  assert.equal(net[0].consultantTotal, 35);
  assert.equal(net[0].netTotal, 65);
  assert.deepEqual(net[0].months, { '2026-08': 65 });
  assert.equal(net[0].stageNumber, '01 · 02');
  assert.equal(net[0].riskStatus, 'Low · High');
});

test('pagination returns complete collections and refuses a full safety-limit page', async () => {
  const pages = [[1, 2], [3]];
  const complete = await collectPages(async (page) => pages[page - 1], {
    pageSize: 2,
    maxPages: 3,
    label: 'test collection',
  });
  assert.deepEqual(complete, [1, 2, 3]);

  await assert.rejects(
    collectPages(async () => [1, 2], { pageSize: 2, maxPages: 2, label: 'test collection' }),
    /4-record safety limit/
  );
  await assert.rejects(
    collectPages(async () => ({ items: [] }), { pageSize: 2, maxPages: 2, label: 'test collection' }),
    /non-array response/
  );
});
