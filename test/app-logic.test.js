'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateExpenseActuals,
  aggregateForecasts,
  aggregateInvoiceFees,
  summarizeInvoiceStatuses,
  buildNetRows,
  compareTenantOfficeNames,
  isArchivedProject,
  moduleMonthTotals,
  parseList,
  resolveExpenseStatusFilter,
  resolveModuleCustomFields,
} = require('../app-logic');

test('tenant office lock accepts an observed subset and rejects offices outside the allow-list', () => {
  const exact = compareTenantOfficeNames(
    ['SJB MEL', 'SJB SYD'],
    ['sjb syd', '  SJB   MEL  ']
  );
  const incomplete = compareTenantOfficeNames(['SJB MEL', 'SJB SYD'], ['SJB MEL']);
  const extra = compareTenantOfficeNames(['SJB MEL', 'SJB SYD'], ['SJB MEL', 'SJB SYD', 'Other']);

  assert.equal(exact.matches, true);
  assert.deepEqual(exact.matchedNames, ['SJB MEL', 'sjb syd']);
  assert.equal(incomplete.matches, true);
  assert.deepEqual(incomplete.missing, ['SJB SYD']);
  assert.equal(extra.matches, false);
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

test('env lists split on commas and trim whitespace around every item', () => {
  assert.deepEqual(parseList(' Stage No , Risk Status,Des / Del ,'), ['Stage No', 'Risk Status', 'Des / Del']);
  assert.deepEqual(parseList('Finance Approved'), ['Finance Approved']);
  assert.deepEqual(parseList('  SJB  MEL ,SJB SYD'), ['SJB MEL', 'SJB SYD']);
  assert.deepEqual(parseList(undefined), []);
});

test('a project is archived by IsActive=false or by an archived workflow status', () => {
  const statuses = ['Archived'];
  assert.equal(isArchivedProject({ IsActive: false, ProjectStatusName: 'Signed' }, statuses), true);
  assert.equal(isArchivedProject({ isActive: false }, statuses), true);
  // SJB's tenant: IsActive stays true and the status carries the archive.
  assert.equal(isArchivedProject({ IsActive: true, ProjectStatusName: 'Archived' }, statuses), true);
  assert.equal(isArchivedProject({ IsActive: true, ProjectStatusName: ' archived ' }, statuses), true);
  assert.equal(isArchivedProject({ IsActive: true, ProjectStatusName: 'Signed' }, statuses), false);
  assert.equal(isArchivedProject({ IsActive: true, ProjectStatusName: 'Unsigned (opportunity)' }, statuses), false);
});

test('invoice status filter matches status names case- and space-insensitively', () => {
  const invoices = aggregateInvoiceFees([
    { StatusCode: 'Finance Approved', Lines: [{ ModuleID: 1, Amount: 100 }] },
    { StatusCode: 'finance  approved', Lines: [{ ModuleID: 1, Amount: 10 }] },
    { StatusCode: 'Approved', Lines: [{ ModuleID: 1, Amount: 1000 }] },
    { StatusCode: 'Draft', Lines: [{ ModuleID: 1, Amount: 5000 }] },
  ], ['Finance Approved']);
  assert.equal(invoices.totalsByModule.get('1'), 110);
});

test('expense status names resolve to IDs; unknown names match only a status-name field', () => {
  const byName = resolveExpenseStatusFilter(['Approved']);
  assert.deepEqual([...byName.ids], ['4']);
  assert.deepEqual(byName.resolved, [{ configured: 'Approved', id: '4', source: 'built-in' }]);

  const mixed = resolveExpenseStatusFilter(['7', 'Signed Off']);
  assert.deepEqual([...mixed.ids], ['7']);
  assert.equal(mixed.resolved[1].source, 'name-field');

  const claims = [
    { ExpenseClaimStatusID: 4, ModuleID: 10, Date: '2026-08-01T00:00:00Z', AmountWithoutTax: 100, CurrencyID: 1, IsPlanned: false },
    { ExpenseClaimStatusID: 2, ModuleID: 10, Date: '2026-08-01T00:00:00Z', AmountWithoutTax: 900, CurrencyID: 1, IsPlanned: false },
    { ExpenseClaimStatusID: 9, ExpenseClaimStatusName: 'Signed off', ModuleID: 10, Date: '2026-08-02T00:00:00Z', AmountWithoutTax: 30, CurrencyID: 1, IsPlanned: false },
  ];
  const options = { moduleProject: new Map([['10', '100']]), projectCurrency: new Map([['100', 1]]), asOfDate: '2026-09-01' };
  assert.equal(aggregateExpenseActuals(claims, { ...options, statusFilter: byName }).totalsByModule.get('10'), 100);
  assert.equal(aggregateExpenseActuals(claims, { ...options, statusFilter: mixed }).totalsByModule.get('10'), 30);
});

test('invoice status summary matches INVOICE_STATUS_CODES case- and whitespace-insensitively', () => {
  const lines = [{ ModuleID: 1, Amount: 100 }];
  const invoices = [
    { StatusID: 4, StatusCode: 'FINANCE  APPROVED ', Lines: lines },
    { StatusID: 4, StatusCode: 'finance approved', Lines: lines },
    { StatusID: 4, StatusCode: 'Finance Approved', Lines: [] },
    { StatusID: 1, StatusCode: 'Draft', Lines: lines },
  ];
  const summary = summarizeInvoiceStatuses(invoices, [' Finance Approved ']);
  assert.equal(summary.total, 4);
  assert.equal(summary.matched, 3);
  assert.deepEqual(summary.statuses.map(([status]) => status).sort(), [
    '"Draft" (StatusID 1)', '"FINANCE  APPROVED " (StatusID 4)', '"Finance Approved" (StatusID 4)', '"finance approved" (StatusID 4)',
  ].sort());
  // The same rule decides Fees to Date.
  assert.equal(aggregateInvoiceFees(invoices, [' Finance Approved ']).totalsByModule.get('1'), 200);
});

test('invoice status summary reports zero matches with the statuses actually seen', () => {
  const summary = summarizeInvoiceStatuses([
    { StatusID: 7, StatusCode: 'Sent', Lines: [] },
    { StatusID: 7, StatusCode: 'Sent', Lines: [] },
    { StatusID: 8, StatusCode: 'Paid', Lines: [] },
  ], ['Finance Approved']);
  assert.equal(summary.matched, 0);
  assert.deepEqual(summary.statuses, [['"Sent" (StatusID 7)', 2], ['"Paid" (StatusID 8)', 1]]);
});
