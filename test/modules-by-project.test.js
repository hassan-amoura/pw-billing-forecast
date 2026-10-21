'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectworksClient } = require('../pw-client');
const { fetchModulesByProject, isArchivedProject, mergeModuleChanges, projectModuleIDs } = require('../app-logic');

/**
 * A fake tenant shaped on SJB: module names repeat across projects, most
 * projects are archived, and each project record lists its ModuleIDs.
 */
function tenant({ projects = 120, perProject = 8, archivedEvery = 4 } = {}) {
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
 * /Modules?ProjectID= with the live API's headers. `failures` maps a ProjectID
 * to how many of its next requests answer with that status; `short` maps one to
 * how many of its next reads drop a row while still counting it.
 */
function api(data, { failures = new Map(), short = new Map(), calls = [] } = {}) {
  return async (url) => {
    const projectID = url.searchParams.get('ProjectID');
    calls.push(projectID);
    const failure = failures.get(projectID);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      return new Response('upstream', { status: failure.status });
    }
    const rows = data.modules.filter((m) => String(m.ProjectID) === projectID);
    let served = rows;
    if ((short.get(projectID) || 0) > 0) {
      short.set(projectID, short.get(projectID) - 1);
      served = rows.slice(1);
    }
    return new Response(JSON.stringify(served), {
      status: 200,
      headers: { 'x-total-count': String(rows.length), 'x-page-count': '1' },
    });
  };
}

function client(fetchImpl) {
  return createProjectworksClient({
    baseUrl: 'http://pw.test', authHeaders: () => ({}), timeoutMs: 1000, pageSize: 1000, retryDelayMs: 1, fetchImpl,
  });
}

const activeOf = (data) => data.projects.filter((p) => !isArchivedProject(p, ['Archived']));
const reader = (pw) => (projectID) =>
  pw.getAllWithReport('/api/v1/Modules', { ProjectID: projectID }, { idKeys: ['ModuleID'] });

test('one read per active project; archived projects are never requested', async () => {
  const data = tenant();
  const calls = [];
  const active = activeOf(data);
  const progress = [];
  const result = await fetchModulesByProject({
    projects: active, fetchProjectModules: reader(client(api(data, { calls }))), concurrency: 10,
    onProgress: (p) => progress.push(p),
  });

  assert.equal(calls.length, active.length);
  const archivedIDs = new Set(data.projects.filter((p) => !active.includes(p)).map((p) => String(p.ProjectID)));
  assert.equal(calls.filter((id) => archivedIDs.has(id)).length, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.modules.length, active.length * 8);
  assert.ok(result.results.every((r) => r.complete && r.modules === r.total));
  assert.deepEqual(progress[0], { done: 0, total: active.length });
  assert.deepEqual(progress.at(-1), { done: active.length, total: active.length });
});

test('at most `concurrency` project reads are in flight', async () => {
  const data = tenant({ projects: 200, archivedEvery: 1 });
  let inFlight = 0;
  let peak = 0;
  const slow = api(data);
  const fetchImpl = async (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    try { return await slow(url); } finally { inFlight -= 1; }
  };
  await fetchModulesByProject({ projects: data.projects, fetchProjectModules: reader(client(fetchImpl)), concurrency: 11 });
  assert.equal(peak, 11);
});

test('429 and 5xx are retried with backoff until the project is complete', async () => {
  const data = tenant();
  const [a, b, c] = activeOf(data).map((p) => String(p.ProjectID));
  const failures = new Map([[a, { status: 429, times: 2 }], [b, { status: 503, times: 1 }], [c, { status: 500, times: 3 }]]);
  const result = await fetchModulesByProject({ projects: activeOf(data), fetchProjectModules: reader(client(api(data, { failures }))) });
  assert.equal(result.failed.length, 0);
  assert.equal(result.modules.length, activeOf(data).length * 8);
});

test('a project read short of its x-total-count is re-read, and reported if it never completes', async () => {
  const data = tenant();
  const [once, always] = activeOf(data).map((p) => String(p.ProjectID));
  const short = new Map([[once, 1], [always, 99]]);
  const retries = [];
  const result = await fetchModulesByProject({
    projects: activeOf(data), fetchProjectModules: reader(client(api(data, { short }))), attempts: 3,
    onRetry: (r) => retries.push(r),
  });

  const byID = new Map(result.results.map((r) => [r.projectID, r]));
  assert.equal(byID.get(once).complete, true);
  assert.equal(byID.get(once).attempts, 2);
  assert.equal(byID.get(always).complete, false);
  assert.equal(byID.get(always).attempts, 3);
  assert.match(byID.get(always).reason, /fetched 7 of x-total-count 8/);
  assert.deepEqual(result.failed.map((f) => f.projectID), [always]);
  assert.equal(result.failed[0].partial.length, 7);
  // A failed project's rows are never mixed into the complete set.
  assert.equal(result.modules.filter((m) => String(m.ProjectID) === always).length, 0);
  assert.equal(retries.length, 1 + 2);
});

test('a project is incomplete when a module its record lists did not arrive, even if x-total-count is met', async () => {
  const data = tenant({ projects: 4, archivedEvery: 1 });
  const project = data.projects[0];
  project.Modules.push(999999); // listed, never served by any read
  const result = await fetchModulesByProject({ projects: [project], fetchProjectModules: reader(client(api(data))), attempts: 2 });
  assert.equal(result.results[0].complete, false);
  assert.match(result.results[0].reason, /1 listed module\(s\) missing/);
});

test('rows for another project (an ignored ProjectID filter) are never accepted', async () => {
  const data = tenant({ projects: 4, archivedEvery: 1 });
  const everything = async () => new Response(JSON.stringify(data.modules), {
    status: 200, headers: { 'x-total-count': String(data.modules.length), 'x-page-count': '1' },
  });
  const result = await fetchModulesByProject({ projects: [data.projects[0]], fetchProjectModules: reader(client(everything)), attempts: 1 });
  assert.equal(result.results[0].complete, false);
  assert.ok(result.modules.every((m) => m.ProjectID === 1));
});

test('a thrown read is recorded as a failure, not a crash', async () => {
  const data = tenant({ projects: 4, archivedEvery: 1 });
  const result = await fetchModulesByProject({
    projects: data.projects.slice(0, 2), attempts: 2,
    fetchProjectModules: async (id) => { if (id === '1') throw new Error('socket hang up'); return reader(client(api(data)))(id); },
  });
  assert.deepEqual(result.failed, [{ projectID: '1', reason: 'socket hang up', partial: [] }]);
  assert.equal(result.modules.length, 8);
});

test('incremental merge: changed modules applied, deletions dropped, mismatched and new projects re-read', () => {
  const data = tenant({ projects: 6, perProject: 3, archivedEvery: 1 });
  const [p1, p2, p3, p4, p5] = data.projects;
  const previousModules = data.modules.filter((m) => m.ProjectID <= 5);
  const previousProjectIDs = [1, 2, 3, 4, 5];

  const renamed = { ...data.modules.find((m) => m.ProjectID === 1), ModuleName: 'Renamed' };
  const added = { ModuleID: 5000, ProjectID: 2, ModuleName: 'New stage' };
  p2.Modules.push(5000);                       // added and reported as changed: no re-read
  const deleted = p3.Modules.pop();            // deleted in Projectworks
  p4.Modules.push(6000);                       // listed but never reported changed: re-read
  const onArchived = { ModuleID: 7000, ProjectID: 99, ModuleName: 'Archived change' };
  const p6 = data.projects[5];                 // newly active, never cached: re-read

  const merge = mergeModuleChanges({
    projects: [p1, p2, p3, p4, p6],            // p5 became archived
    previousProjectIDs,
    previousModules,
    changedModules: [renamed, added, onArchived],
  });

  const ids = new Set(merge.modules.map((m) => m.ModuleID));
  assert.deepEqual(merge.toFetch.sort(), ['4', '6']);
  assert.equal(merge.modules.find((m) => m.ModuleID === renamed.ModuleID).ModuleName, 'Renamed');
  assert.ok(ids.has(5000));
  assert.ok(!ids.has(deleted));
  assert.ok(!ids.has(7000));
  assert.ok(!merge.modules.some((m) => m.ProjectID === 5 || m.ProjectID === 4 || m.ProjectID === 6));
  assert.equal(merge.removed, 1);
  assert.equal(merge.updated, 2);
  assert.equal(p5.ProjectID, 5);
});

test('projectModuleIDs reads the live API\'s plain ID array, object entries, and the slim ModuleIDs', () => {
  assert.deepEqual(projectModuleIDs({ Modules: [152277, 152278] }), ['152277', '152278']);
  assert.deepEqual(projectModuleIDs({ Modules: [{ ModuleID: 5 }] }), ['5']);
  assert.deepEqual(projectModuleIDs({ ModuleIDs: [7] }), ['7']);
  assert.equal(projectModuleIDs({}), null);
});
