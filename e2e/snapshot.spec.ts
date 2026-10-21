import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { expect, test } from '@playwright/test';
import { APP_WRITES_ON_PORT, GATE, appEnv } from './support/env';
import { delayModules, loadGrid, mockState, resetMock, waitForGrid } from './support/grid';

/**
 * The grid is served from the server's last complete snapshot: instantly on
 * page load, from memory or — after a restart — from Postgres. Load data
 * refreshes it in the background while the previous data stays on screen.
 */
test.describe('snapshot: instant load and background refresh', () => {
  test.afterEach(async ({ request }) => resetMock(request));

  test('after one load, opening the page shows the grid without pressing Load data', async ({ page, request }) => {
    const { expected } = await mockState(request);
    await loadGrid(page);
    await expect(page.getByTestId('last-refreshed')).toHaveText(/^Last refreshed \d{1,2}:\d{2}/);

    await page.reload();
    // No click: the page-load request is served from the snapshot.
    await expect(page.getByTestId('grid')).toBeVisible();
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
    await expect(page.getByTestId('last-refreshed')).toHaveText(/^Last refreshed \d{1,2}:\d{2}/);
    await expect(page.getByTestId('load-button')).toHaveText('Load data');
  });

  test('Load data refreshes in the background with visible progress, then swaps in', async ({ page, request }) => {
    const { expected } = await mockState(request);
    await loadGrid(page);
    await delayModules(request, 1500);

    await page.getByTestId('load-button').click();
    const progress = page.getByTestId('refresh-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('Refreshing…');
    await expect(page.getByTestId('load-button')).toHaveText('Refreshing…');
    // The previous snapshot stays on screen and filterable meanwhile.
    await expect(page.getByTestId('grid')).toBeVisible();
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));

    await waitForGrid(page);
    await expect(progress).toBeHidden();
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
  });

  test('a restarted server serves the snapshot from Postgres without reading Projectworks modules', async ({ page, request }) => {
    await loadGrid(page); // the writes-on instance stores a snapshot
    // A second process on the same database and INSTANCE_ID: nothing in memory.
    const port = 4314;
    const server: ChildProcess = spawn('node', ['../server.js'], {
      cwd: path.join(__dirname),
      env: appEnv(port, { INSTANCE_ID: `e2e-${APP_WRITES_ON_PORT}` }),
      stdio: 'ignore',
    });
    try {
      const auth = { Authorization: 'Basic ' + Buffer.from(`${GATE.username}:${GATE.password}`).toString('base64') };
      await expect.poll(async () => {
        try { return (await request.get(`http://127.0.0.1:${port}/healthz`)).status(); } catch { return 0; }
      }, { timeout: 30_000 }).toBe(200);
      // Make any Projectworks module read hang far beyond the assertion below.
      await delayModules(request, 60_000);
      const now = new Date();
      const ym = (offset: number) => {
        const d = new Date(now.getFullYear(), now.getMonth() + offset, 15);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      };
      const res = await request.get(`http://127.0.0.1:${port}/api/grid?start=${ym(0)}&end=${ym(11)}&office=all&ifCached=1`,
        { headers: auth, timeout: 10_000 });
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.snapshot).not.toBe(false);
      expect(body.meta.fromSnapshot).toBe(true);
      expect(body.meta.integrityErrors).toBeUndefined();
      expect(body.meta.warnings).toBeUndefined();
      expect(body.rows.length).toBeGreaterThan(0);
    } finally {
      server.kill('SIGTERM');
    }
  });
});
