'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectworksClient } = require('../pw-client');
const { isArchivedProject, projectModuleIDs, reconcileModules } = require('../app-logic');

/**
 * A fake tenant shaped on SJB: module names repeat across projects, most
 * projects are archived, and each project record lists its ModuleIDs.
 */
function tenant({ projects = 400, perProject = 8, archivedEvery = 4 } = {}) {
  const projectRows = [];
  const modules = [];
  let nextModuleID = 1000;
  for (let p = 1; p <= projects; p += 1) {
    const archived = p % archivedEvery !== 0; // 3 in 4 archived, as on SJB
    const project = { ProjectID: p, ProjectStatusName: archived ? 'Archived' : 'Signed', IsActive: true, Modules: [] };
    for (let i = 0; i < perProject; i += 1) {
      const m = { ModuleID: nextModuleID++, ProjectID: p, ModuleName: `Stage ${i + 1}` };
      modules.push(m);
      project.Modules.push(m.ModuleID);
    }
    projectRows.push(project);
  }
  return { projects: projectRows, modules };
}

/**
 * /Modules sorted by ModuleName with ties broken at random on EVERY request —
 * the live API's behaviour — so no two page reads agree and re-reading cannot
 * converge. ProjectID-filtered reads return that project's modules. `hidden`
 * modules are counted in x-total-count but never served.
 */
function unstableApi(data, { cap = 250, hidden = new Set(), calls } = {}) {
  return async (url) => {
    const page = Number(url.searchParams.get('page')) || 1;
    const size = Math.min(Number(url.searchParams.get('pageSize')) || cap, cap);
    const projectID = url.searchParams.get('ProjectID');
    calls.push(projectID ? `project:${projectID}` : `page:${page}`);
    const all = data.modules
      .filter((m) => !projectID || String(m.ProjectID) === projectID)
      .map((m) => ({ m, tie: Math.random() }))
      .sort((a, b) => a.m.ModuleName.localeCompare(b.m.ModuleName) || a.tie - b.tie)
      .map(({ m }) => m);
    const served = all.filter((m) => !hidden.has(m.ModuleID));
    return new Response(JSON.stringify(served.slice((page - 1) * size, page * size)), {
      status: 200,
      headers: { 'x-total-count': String(all.length), 'x-page-count': String(Math.ceil(all.length / size)) },
    });
  };
}

async function readAndReconcile(data, options = {}) {
  const calls = [];
  const pw = createProjectworksClient({
    baseUrl: 'http://pw.test', authHeaders: () => ({}), timeoutMs: 1000, pageSize: 1000, retryDelayMs: 1,
    fetchImpl: unstableApi(data, { ...options, calls }),
  });
  const paged = await pw.getAllWithReport('/api/v1/Modules', {}, { idKeys: ['ModuleID'] });
  const result = await reconcileModules({
    projects: data.projects,
    modules: paged.rows,
    isArchived: (p) => isArchivedProject(p, ['Archived']),
    fetchProjectModules: (projectID) => pw.getAllWithReport('/api/v1/Modules', { ProjectID: projectID }, { idKeys: ['ModuleID'] }),
  });
  return { paged, result, calls };
}

test('unstable page order on every request: every active project ends exact, with no page re-read', async () => {
  const data = tenant();
  const { paged, result, calls } = await readAndReconcile(data);
  // The paged read really is broken: many duplicates, many missing.
  assert.ok(paged.report.duplicates > 100, `expected heavy duplication, got ${paged.report.duplicates}`);
  assert.equal(paged.report.complete, false);

  const active = data.projects.filter((p) => p.ProjectStatusName !== 'Archived');
  const activeIDs = new Set(active.flatMap((p) => p.Modules));
  const got = new Set(result.modules.map((m) => m.ModuleID));
  for (const id of activeIDs) assert.ok(got.has(id), `active module ${id} missing`);
  assert.equal(result.modules.length, got.size, 'no duplicates survive');
  assert.equal(result.detectable, true);
  assert.deepEqual(result.missingActive, []);
  // Archived gaps are counted, never fetched.
  assert.equal(result.missingArchived, data.modules.length - paged.rows.length - result.recovered);
  const projectCalls = calls.filter((c) => c.startsWith('project:'));
  assert.equal(projectCalls.length, result.refetchedProjects);
  assert.ok(projectCalls.every((c) => active.some((p) => `project:${p.ProjectID}` === c)), 'only active projects are re-read');
  // Exactly one read of each page: 3,200 modules at 250 per page.
  assert.equal(calls.filter((c) => c.startsWith('page:')).length, 13);
});

test('a stable read that lost nothing re-reads nothing', async () => {
  const data = tenant({ projects: 10, perProject: 3 });
  const modules = data.modules.slice();
  let fetched = 0;
  const result = await reconcileModules({
    projects: data.projects, modules, isArchived: () => false,
    fetchProjectModules: async () => { fetched += 1; return { rows: [], report: { complete: true } }; },
  });
  assert.equal(fetched, 0);
  assert.equal(result.modules.length, 30);
});

test('an active stage no read can return is reported missing; an archived one only counted', async () => {
  const data = tenant({ projects: 8, perProject: 4 });
  const activeProject = data.projects.find((p) => p.ProjectStatusName !== 'Archived');
  const archivedProject = data.projects.find((p) => p.ProjectStatusName === 'Archived');
  const lostActive = activeProject.Modules[1];
  const lostArchived = archivedProject.Modules[2];
  const { result } = await readAndReconcile(data, { hidden: new Set([lostActive, lostArchived]), cap: 1000 });
  assert.deepEqual(result.missingActive, [{ projectID: String(activeProject.ProjectID), moduleIDs: [String(lostActive)] }]);
  assert.equal(result.missingArchived, 1);
  assert.equal(result.missingArchivedProjects, 1);
});

test('a listed module a complete per-project read does not return was deleted, not missing', async () => {
  const projects = [{ ProjectID: 1, ProjectStatusName: 'Signed', Modules: [10, 11] }];
  const result = await reconcileModules({
    projects,
    modules: [{ ModuleID: 10, ProjectID: 1 }],
    isArchived: () => false,
    fetchProjectModules: async () => ({ rows: [{ ModuleID: 10, ProjectID: 1 }], report: { complete: true } }),
  });
  assert.deepEqual(result.missingActive, []);
  assert.equal(result.refetchedProjects, 1);
});

test('a failed per-project read leaves its gap reported, and a row for another project is not taken', async () => {
  const projects = [
    { ProjectID: 1, ProjectStatusName: 'Signed', Modules: [10, 11] },
    { ProjectID: 2, ProjectStatusName: 'Signed', Modules: [20] },
  ];
  const result = await reconcileModules({
    projects,
    modules: [{ ModuleID: 10, ProjectID: 1 }],
    isArchived: () => false,
    fetchProjectModules: async (projectID) => {
      if (projectID === '2') throw new Error('GET /api/v1/Modules → 503');
      // An API that ignored the ProjectID filter.
      return { rows: [{ ModuleID: 11, ProjectID: 1 }, { ModuleID: 20, ProjectID: 2 }], report: { complete: true } };
    },
  });
  assert.deepEqual(result.missingActive, [{ projectID: '2', moduleIDs: ['20'], error: 'GET /api/v1/Modules → 503' }]);
  assert.equal(result.recovered, 1);
});

test('without project module lists the gap cannot be detected and nothing is re-read', async () => {
  const result = await reconcileModules({
    projects: [{ ProjectID: 1 }], modules: [], isArchived: () => false,
    fetchProjectModules: async () => { throw new Error('should not be called'); },
  });
  assert.equal(result.detectable, false);
});

test('projectModuleIDs reads the live API\'s plain ID array, object entries, and the slim ModuleIDs', () => {
  assert.deepEqual(projectModuleIDs({ Modules: [152277, 152278] }), ['152277', '152278']);
  assert.deepEqual(projectModuleIDs({ Modules: [{ ModuleID: 5 }] }), ['5']);
  assert.deepEqual(projectModuleIDs({ ModuleIDs: [7] }), ['7']);
  assert.equal(projectModuleIDs({}), null);
});
