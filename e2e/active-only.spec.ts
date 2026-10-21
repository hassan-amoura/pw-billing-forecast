import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { expect, test } from '@playwright/test';
import { appEnv } from './support/env';
import {
  defaultWindow, deleteModule, expectNoErrorCopy, failProjects, hideModules, loadGrid, mockState, moduleRequests,
  moduleRow, renameModule, resetMock, search, shortProjects, startFullRefresh, waitForGrid,
} from './support/grid';

/**
 * Archived projects are excluded altogether: never requested, never stored,
 * never shown. Modules are read one GET /Modules?ProjectID= per active project
 * and each project is checked against its own x-total-count and module list.
 * After the first full sync, Load data reads only what changed.
 */
test.describe('active projects only, read one project at a time', () => {
  test.afterEach(async ({ request }) => {
    await resetMock(request);
    await startFullRefresh(request); // leave the shared app with a clean, complete snapshot
  });

  test('a full sync requests modules only for active projects, never in bulk, and no archived project is shown', async ({ page, request }) => {
    const { expected, named } = await mockState(request);
    const before = await moduleRequests(request);
    await startFullRefresh(request);
    const after = await moduleRequests(request);

    const requested = after.projectIDs.slice(before.projectIDs.length);
    expect(after.modulesPaged - before.modulesPaged).toBe(0);
    expect(requested.length).toBe(expected.activeProjects);
    expect(new Set(requested).size).toBe(expected.activeProjects);
    const archived = new Set(named.archivedProjectIDs);
    expect(requested.filter((id) => archived.has(id))).toEqual([]);

    await page.goto('/');
    await waitForGrid(page);
    await expect(page.getByTestId('meta-projects')).toHaveText(expected.activeProjects.toLocaleString('en-US'));
    await expect(page.getByTestId('meta-stages')).toHaveText(expected.active.stages.toLocaleString('en-US'));
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
    await expect(page.getByTestId('toggle-archived')).toHaveCount(0);
    await expect(page.getByText('Show archived projects')).toHaveCount(0);
    // Archived by status (IsActive still true) and by IsActive=false.
    await search(page, 'Zulu Archive');
    await expect(page.getByTestId('footer-count')).toHaveText('0');
    await search(page, 'Yankee Legacy');
    await expect(page.getByTestId('footer-count')).toHaveText('0');

    // Nor does the API send them, whatever is asked for.
    const { start, end } = defaultWindow();
    const body = await (await page.request.get(`/api/grid?start=${start}&end=${end}&office=all&includeArchived=1`)).json();
    expect(body.rows.length).toBe(expected.active.stages);
    expect(body.rows.filter((r: { projectID: number }) => archived.has(r.projectID))).toEqual([]);
  });

  test('Load data after a full sync reads only changes: edits and deletions applied, no project re-read', async ({ page, request }) => {
    const { named } = await mockState(request);
    await startFullRefresh(request);
    await page.goto('/');
    await waitForGrid(page);

    await renameModule(request, named.alphaA, 'Stage A Revised');
    await deleteModule(request, named.bravoA);
    const before = await moduleRequests(request);
    await page.getByTestId('load-button').click();
    await waitForGrid(page);
    const after = await moduleRequests(request);

    expect(after.modulesModifiedSince - before.modulesModifiedSince).toBe(1);
    expect(after.modulesByProject - before.modulesByProject).toBe(0);
    expect(after.modulesPaged - before.modulesPaged).toBe(0);
    await search(page, 'Alpha Tower');
    await expect(moduleRow(page, named.alphaA)).toContainText('Stage A Revised');
    await search(page, 'Bravo House');
    await expect(page.getByTestId('footer-count')).toHaveText('0');
  });

  test('a project read short of its x-total-count is re-read until complete', async ({ page, request }) => {
    const { named } = await mockState(request);
    await shortProjects(request, [1], 1);
    const before = await moduleRequests(request);
    await startFullRefresh(request);
    const after = await moduleRequests(request);
    expect(after.projectIDs.slice(before.projectIDs.length).filter((id) => id === 1)).toHaveLength(2);

    await page.goto('/');
    await waitForGrid(page);
    await search(page, 'Alpha Tower');
    await expect(moduleRow(page, named.alphaA)).toBeVisible();
    await expect(moduleRow(page, named.alphaB)).toBeVisible();
  });

  test('429 and 500 on a project are retried with backoff, and the project arrives complete', async ({ page, request }) => {
    const { named } = await mockState(request);
    await failProjects(request, [1], 429, 2);
    await failProjects(request, [2], 500, 1);
    const before = await moduleRequests(request);
    await startFullRefresh(request);
    const after = await moduleRequests(request);
    const requested = after.projectIDs.slice(before.projectIDs.length);
    expect(requested.filter((id) => id === 1)).toHaveLength(3);
    expect(requested.filter((id) => id === 2)).toHaveLength(2);

    await page.goto('/');
    await waitForGrid(page);
    await search(page, 'Alpha Tower');
    await expect(moduleRow(page, named.alphaB)).toBeVisible();
    await search(page, 'Bravo House');
    await expect(moduleRow(page, named.bravoA)).toBeVisible();
  });

  test('a project that cannot be read keeps its last good stages, and nothing on screen says so', async ({ page, request }) => {
    const { expected, named } = await mockState(request);
    await startFullRefresh(request); // a good snapshot to fall back on
    await hideModules(request, [named.alphaB]); // project 1 is now short on every read
    await startFullRefresh(request);

    await page.goto('/');
    await waitForGrid(page);
    await expect(page.getByTestId('meta-stages')).toHaveText(expected.active.stages.toLocaleString('en-US'));
    await expectNoErrorCopy(page);
    await search(page, 'Alpha Tower');
    await expect(moduleRow(page, named.alphaB)).toBeVisible();
    await expectNoErrorCopy(page);
  });

  test('a first sync that cannot complete still shows the grid, with no error copy', async ({ page, request }) => {
    const { named } = await mockState(request);
    await hideModules(request, [named.alphaB]);
    // A fresh instance: no snapshot yet, so opening the page starts the first sync.
    const port = 4315;
    const server: ChildProcess = spawn('node', ['../server.js'], {
      cwd: path.join(__dirname),
      env: appEnv(port, { INSTANCE_ID: `e2e-first-sync-${Date.now()}` }),
      stdio: 'ignore',
    });
    try {
      await expect.poll(async () => {
        try { return (await request.get(`http://127.0.0.1:${port}/healthz`)).status(); } catch { return 0; }
      }, { timeout: 30_000 }).toBe(200);
      await page.goto(`http://127.0.0.1:${port}/`);
      await expect(page.getByTestId('refresh-progress')).toContainText(/Refreshing…/);
      await waitForGrid(page);
      await expect(page.getByTestId('last-refreshed')).toHaveText(/^Last refreshed \d{1,2}:\d{2}/);
      await expectNoErrorCopy(page);
      await search(page, 'Alpha Tower');
      await expect(moduleRow(page, named.alphaA)).toBeVisible();
      await expect(moduleRow(page, named.alphaB)).toHaveCount(0);
      await expectNoErrorCopy(page);
    } finally {
      server.kill('SIGTERM');
    }
  });
});
