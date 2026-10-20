'use strict';

/**
 * Deterministic fixture tenant for the mocked Projectworks API.
 *
 * Shaped on SJB's live tenant (verified 2026-10-20): two offices, most
 * projects archived through ProjectStatusName "Archived" while IsActive stays
 * true, a few archived through IsActive=false, modules in PascalCase with
 * CustomFields entries carrying Label/FieldID/Value, and invoices/expenses in
 * a mix of statuses. Well over 20,000 modules so any page cap shows up.
 *
 * Named records the specs rely on are listed in NAMED; everything else is
 * generated from a seeded PRNG. `expected` is computed from the same data the
 * mock serves, so the assertions never drift from the fixtures.
 */

const OFFICES = [
  { OfficeID: 1, Name: 'SJB SYD', FullName: 'SJB Architects Sydney', IsActive: true, CurrencyID: 5, CurrencyCode: 'AUD' },
  { OfficeID: 2, Name: 'SJB MEL', FullName: 'SJB Architecture Pty Ltd', IsActive: true, CurrencyID: 5, CurrencyCode: 'AUD' },
];
const STATUS = { signed: [3, 'Signed'], opportunity: [2, 'Unsigned (opportunity)'], archived: [6, 'Archived'] };
const FIELD = { desDel: 3, stageNo: 18, risk: 19 };
const GENERATED_PROJECTS = 1300;
const MODULES_PER_PROJECT = 17;

function month(offset) {
  const d = new Date();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
  return m.toISOString().slice(0, 7);
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function customFields({ stageNo = null, risk = null, desDel = null } = {}) {
  const base = { Group: null, Order: null, EntityTypeID: 4, EntityTypeName: 'Project Budget', EntitySubTypeID: 5, EntitySubTypeName: 'Main', IsActive: true, IsMandatory: false, MultiSelectValues: null };
  return [
    { ...base, FieldID: FIELD.desDel, Label: 'Des / Del', TypeID: 6, TypeName: 'Select', Value: desDel },
    { ...base, FieldID: FIELD.stageNo, Label: 'Stage No', TypeID: 1, TypeName: 'Text', Value: stageNo },
    { ...base, FieldID: FIELD.risk, Label: 'Risk Status', TypeID: 6, TypeName: 'Select', Value: risk },
  ];
}

function buildFixtures() {
  const rand = mulberry32(20261020);
  const projects = [];
  const modules = [];
  const invoices = [];
  const expenseClaims = [];
  const forecasts = [];
  let nextModuleID = 130000;
  let nextInvoiceID = 50000;
  let nextClaimID = 70000;
  let nextForecastID = 90000;

  const project = (id, name, office, status, isActive = true) => {
    const p = {
      ProjectID: id, ProjectNumber: `P-${String(id).padStart(5, '0')}`, ProjectName: name,
      OfficeID: office.OfficeID, OfficeName: office.Name, ClientID: 1, ClientName: 'Client',
      ProjectTypeID: 1, ProjectTypeName: id % 2 ? 'Architecture' : 'Interiors',
      ProjectStatusID: status[0], ProjectStatusName: status[1], CurrencyID: 5, CurrencyCode: 'AUD',
      ProjectManagerID: 10 + (id % 4), ProjectManagerName: ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra'][id % 4],
      IsActive: isActive, Modules: [], CustomFields: [],
    };
    projects.push(p);
    return p;
  };
  const module = (p, name, { services = true, active = true, budget = 10000, fields = {} } = {}) => {
    const m = {
      ModuleID: nextModuleID++, ModuleName: name, ProjectID: p.ProjectID, Projectname: p.ProjectName,
      Budget: budget, GLCodeID: 1, GLCodeCode: services ? '4000' : '5100', GLCodeName: services ? 'Fees' : 'Subconsultants',
      GLCodeTypeID: services ? 1 : 2, GLCodeTypeName: services ? 'Income' : 'Consultant',
      IsDiscount: false, IsActive: active, IsServices: services, FeeTypeID: 1,
      Tasks: [{ TaskID: 1, TaskName: 'Task' }], CustomFields: customFields(fields),
    };
    modules.push(m);
    return m;
  };
  const invoice = (p, m, statusCode, statusID, amount) => invoices.push({
    InvoiceID: nextInvoiceID++, InvoiceNumber: `INV-${nextInvoiceID}`, StatusID: statusID, StatusCode: statusCode,
    ProjectID: p.ProjectID, CurrencyID: 5, CurrencyCode: 'AUD', InvoiceDate: `${month(-2)}-15T00:00:00`,
    Lines: [{ LineID: nextInvoiceID, ModuleID: m.ModuleID, ModuleName: m.ModuleName, Amount: amount }],
  });
  const claim = (m, statusID, amount) => expenseClaims.push({
    ExpenseClaimID: nextClaimID++, ProjectID: m.ProjectID, ModuleID: m.ModuleID, ExpenseClaimStatusID: statusID,
    IsPlanned: false, Date: `${month(-1)}-10T00:00:00`, AmountWithoutTax: amount, Amount: amount * 1.1, CurrencyID: 5,
  });
  const forecast = (m, monthKey, amount) => forecasts.push({
    ForecastID: nextForecastID++, ModuleID: m.ModuleID, ProjectID: m.ProjectID, Date: `${monthKey}-01T00:00:00`, Amount: amount,
  });

  // ---- named records the specs assert on --------------------------------
  const alpha = project(1, 'Alpha Tower', OFFICES[0], STATUS.signed);
  const alphaA = module(alpha, 'Stage A Concept', { budget: 50000, fields: { stageNo: '01.10', risk: 'Low', desDel: 'Des' } });
  const alphaB = module(alpha, 'Stage B Design', { budget: 40000, fields: {} }); // Stage No unset
  const alphaC = module(alpha, 'Consultants Structural', { services: false, budget: 20000, fields: { stageNo: '09' } });
  invoice(alpha, alphaA, 'Finance Approved', 4, 12000);
  invoice(alpha, alphaA, 'Draft', 1, 5000);
  invoice(alpha, alphaA, 'Approved', 3, 700); // a different status — must not count
  claim(alphaC, 4, 2500); // approved (ID 4)
  claim(alphaC, 2, 9999); // submitted — must not count
  forecast(alphaA, month(1), 3000);

  const bravo = project(2, 'Bravo House', OFFICES[1], STATUS.signed);
  const bravoA = module(bravo, 'Stage 1 Brief', { budget: 15000, fields: { stageNo: '02.01' } });
  invoice(bravo, bravoA, 'Finance Approved', 4, 1500);

  const zulu = project(3, 'Zulu Archive', OFFICES[0], STATUS.archived, true);
  module(zulu, 'Stage Z Closed', { budget: 9000, fields: { stageNo: '99.01' } });

  const yankee = project(4, 'Yankee Legacy', OFFICES[1], STATUS.signed, false);
  module(yankee, 'Stage Y Old', { budget: 7000, fields: { stageNo: '98.01' } });

  // ---- generated volume ---------------------------------------------------
  for (let i = 0; i < GENERATED_PROJECTS; i += 1) {
    const id = 100 + i;
    const office = rand() < 0.25 ? OFFICES[1] : OFFICES[0];
    const r = rand();
    const status = r < 0.7 ? STATUS.archived : (r < 0.95 ? STATUS.signed : STATUS.opportunity);
    const isActive = status === STATUS.archived ? true : rand() > 0.03;
    const p = project(id, `Project ${String(id).padStart(4, '0')}`, office, status, isActive);
    for (let j = 0; j < MODULES_PER_PROJECT; j += 1) {
      const m = module(p, `Stage ${String(j + 1).padStart(2, '0')}`, {
        services: rand() < 0.95,
        active: rand() < 0.98,
        budget: Math.round(rand() * 50000),
        fields: { stageNo: rand() < 0.6 ? `${String(j + 1).padStart(2, '0')}.${(i % 9) + 1}` : null },
      });
      if (m.IsServices && rand() < 0.12) invoice(p, m, rand() < 0.85 ? 'Finance Approved' : 'Draft', 4, Math.round(rand() * 8000));
      if (!m.IsServices && rand() < 0.5) claim(m, rand() < 0.8 ? 4 : 2, Math.round(rand() * 3000));
      if (m.IsServices && rand() < 0.1) forecast(m, month(1 + Math.floor(rand() * 6)), Math.round(rand() * 6000));
    }
  }

  // The live API does not return modules in ID order; neither does the mock.
  for (let i = modules.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [modules[i], modules[j]] = [modules[j], modules[i]];
  }

  const users = [
    { UserID: 11, FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@example.test' },
    { UserID: 12, FirstName: 'Grace', LastName: 'Hopper', Email: 'grace@example.test' },
  ];

  // ---- expected counts --------------------------------------------------
  const archived = (p) => p.IsActive === false || p.ProjectStatusName === 'Archived';
  const projectByID = new Map(projects.map((p) => [p.ProjectID, p]));
  const keep = (m, { includeArchived = false, officeID = null } = {}) => {
    const p = projectByID.get(m.ProjectID);
    return (includeArchived || !archived(p)) && (!officeID || p.OfficeID === officeID);
  };
  const grossDefault = (m) => m.IsServices && m.IsActive; // Gross tab, "Show inactive stages" off
  const count = (opts) => {
    const kept = modules.filter((m) => keep(m, opts));
    return { stages: kept.length, gross: kept.filter(grossDefault).length };
  };
  const expected = {
    totalModules: modules.length,
    totalProjects: projects.length,
    archivedProjects: projects.filter(archived).length,
    activeProjects: projects.filter((p) => !archived(p)).length,
    active: count({}),
    withArchived: count({ includeArchived: true }),
    syd: count({ officeID: 1 }),
    mel: count({ officeID: 2 }),
  };

  return {
    offices: OFFICES, projects, modules, invoices, expenseClaims, forecasts, users, expected,
    named: { alphaA: alphaA.ModuleID, alphaB: alphaB.ModuleID, alphaC: alphaC.ModuleID, bravoA: bravoA.ModuleID, forecastMonth: month(1) },
  };
}

module.exports = { buildFixtures, FIELD };
