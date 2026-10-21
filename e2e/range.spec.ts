import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { GATE, appEnv } from './support/env';
import {
  delayModules, mockState, moduleRequests, moduleRow, monthFromNow, pickMonth, resetMock, search, startFullRefresh,
  waitForGrid, type ModuleRequests,
} from './support/grid';

/**
 * The project and stage cache does not depend on the forecast range. Changing
 * Forecast Start/End reloads the grid at once: a range not seen before costs
 * one GET /Forecasts and nothing else; a range already seen costs nothing.
 */
const MONTH = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const label = (month: string) => `${MONTH[Number(month.slice(5, 7)) - 1]} ${month.slice(2, 4)}`;

function delta(after: ModuleRequests, before: ModuleRequests) {
  return {
    projects: after.projects - before.projects,
    modules: after.modulesPaged - before.modulesPaged + after.modulesByProject - before.modulesByProject +
      after.modulesModifiedSince - before.modulesModifiedSince,
    invoices: after.invoices - before.invoices,
    expenseClaims: after.expenseClaims - before.expenseClaims,
    forecasts: after.forecasts - before.forecasts,
  };
}

async function expectRange(page: Page, start: string, end: string) {
  await waitForGrid(page);
  const head = page.locator('#head');
  await expect(head).toContainText(label(start));
  await expect(head).toContainText(label(end));
  await expect(page.getByTestId('refresh-progress')).toBeHidden();
}

/** A dedicated app process, so this spec's caches start empty on every run. */
function startApp(port: number, instanceID: string): ChildProcess {
  return spawn('node', ['../server.js'], { cwd: path.join(__dirname), env: appEnv(port, { INSTANCE_ID: instanceID }), stdio: 'ignore' });
}
async function waitHealthy(request: APIRequestContext, url: string) {
  await expect.poll(async () => {
    try { return (await request.get(`${url}/healthz`)).status(); } catch { return 0; }
  }, { timeout: 30_000 }).toBe(200);
}

test.describe('forecast range changes', () => {
  const instanceID = `e2e-range-${Date.now()}`;
  const port = 4317;
  const appUrl = `http://127.0.0.1:${port}`;
  let app: ChildProcess;
  test.beforeAll(async ({ request }) => {
    app = startApp(port, instanceID);
    await waitHealthy(request, appUrl);
  });
  test.afterAll(() => { app?.kill('SIGTERM'); });
  test.afterEach(async ({ request }) => resetMock(request));

  test('changing Forecast Start/End re-reads only that range\'s forecasts, and a seen range nothing', async ({ page, request }) => {
    const { expected, named } = await mockState(request);
    await startFullRefresh(request, { appUrl });
    await page.goto(`${appUrl}/`);
    await expectRange(page, monthFromNow(0), monthFromNow(11));
    // A project or stage read would now hang far past every assertion below.
    await delayModules(request, 60_000);

    // A new range: one /Forecasts read, nothing else.
    let before = await moduleRequests(request);
    await pickMonth(page, 'f-end', monthFromNow(5));
    await expectRange(page, monthFromNow(0), monthFromNow(5));
    await expect(page.locator('#head')).not.toContainText(label(monthFromNow(6)));
    expect(delta(await moduleRequests(request), before)).toEqual({ projects: 0, modules: 0, invoices: 0, expenseClaims: 0, forecasts: 1 });
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
    await search(page, 'Alpha Tower');
    // Stage A's forecast (next month) is inside the new range, read with it.
    await expect(moduleRow(page, named.alphaA).locator(`input[data-month="${named.forecastMonth}"]`)).toHaveValue('3000');
    await search(page, '');

    // Another new range, via Forecast Start.
    before = await moduleRequests(request);
    await pickMonth(page, 'f-start', monthFromNow(1));
    await expectRange(page, monthFromNow(1), monthFromNow(5));
    expect(delta(await moduleRequests(request), before)).toEqual({ projects: 0, modules: 0, invoices: 0, expenseClaims: 0, forecasts: 1 });

    // Back to ranges already seen: no Projectworks read at all.
    before = await moduleRequests(request);
    await pickMonth(page, 'f-start', monthFromNow(0));
    await expectRange(page, monthFromNow(0), monthFromNow(5));
    await pickMonth(page, 'f-end', monthFromNow(11));
    await expectRange(page, monthFromNow(0), monthFromNow(11));
    expect(delta(await moduleRequests(request), before)).toEqual({ projects: 0, modules: 0, invoices: 0, expenseClaims: 0, forecasts: 0 });
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
  });

  test('a restarted server serves a new range from the stored dataset plus one /Forecasts read', async ({ request }) => {
    const { expected } = await mockState(request);
    await startFullRefresh(request, { appUrl }); // stores the dataset in Postgres
    // A second process on the same database and INSTANCE_ID: nothing in memory.
    const restartedUrl = 'http://127.0.0.1:4316';
    const restarted = startApp(4316, instanceID);
    try {
      await waitHealthy(request, restartedUrl);
      await delayModules(request, 60_000);
      const before = await moduleRequests(request);
      const auth = { Authorization: 'Basic ' + Buffer.from(`${GATE.username}:${GATE.password}`).toString('base64') };
      const res = await request.get(`${restartedUrl}/api/grid?start=${monthFromNow(2)}&end=${monthFromNow(4)}&office=all&ifCached=1`,
        { headers: auth, timeout: 15_000 });
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.meta.fromSnapshot).toBe(true);
      expect(body.meta.modules).toBe(expected.active.stages);
      expect(delta(await moduleRequests(request), before)).toEqual({ projects: 0, modules: 0, invoices: 0, expenseClaims: 0, forecasts: 1 });
    } finally {
      restarted.kill('SIGTERM');
    }
  });
});
