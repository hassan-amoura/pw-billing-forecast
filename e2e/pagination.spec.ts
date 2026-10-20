import { expect, test } from '@playwright/test';
import {
  hideModules, loadGrid, mockState, moduleRequests, resetMock, search, setUnstableModuleOrder, shiftModulePages,
} from './support/grid';

/**
 * Production: /Modules is sorted by ModuleName with nothing to break ties and
 * honours no sort parameter, so offset pages overlap and gap differently on
 * every read (27,779 came back as ~27,655 unique, every time). Re-reading
 * pages cannot converge. The app reads each page once, then re-reads by
 * ProjectID only the active projects whose listed modules did not arrive.
 */
test.describe('pagination over an unstable sort', () => {
  test.afterEach(async ({ request }) => {
    await resetMock(request);
  });

  test('a production-sized shift is recovered: every active stage arrives and no banner shows', async ({ page, request }) => {
    const { expected } = await mockState(request);
    await shiftModulePages(request, [3, 7], 64, 'always');

    await loadGrid(page);
    await expect(page.getByTestId('load-error')).toBeHidden();
    await expect(page.getByTestId('integrity-banner')).toBeHidden();
    await expect(page.getByTestId('meta-stages')).toHaveText(expected.active.stages.toLocaleString('en-US'));
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
  });

  test('page order reshuffled on EVERY request still converges, with each page read once', async ({ page, request }) => {
    const { expected } = await mockState(request);
    await setUnstableModuleOrder(request, true);
    const before = await moduleRequests(request);

    await loadGrid(page);
    await expect(page.getByTestId('load-error')).toBeHidden();
    await expect(page.getByTestId('integrity-banner')).toBeHidden();
    await expect(page.getByTestId('meta-stages')).toHaveText(expected.active.stages.toLocaleString('en-US'));
    await expect(page.getByTestId('meta-projects')).toHaveText(expected.activeProjects.toLocaleString('en-US'));
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));

    // One pass over the pages (22,106 modules at the mock's 750 cap), then
    // ProjectID reads for active projects only.
    const after = await moduleRequests(request);
    expect(after.modulesPaged - before.modulesPaged).toBe(Math.ceil(expected.totalModules / 750));
    expect(after.modulesByProject - before.modulesByProject).toBeGreaterThan(0);
    expect(after.modulesByProject - before.modulesByProject).toBeLessThanOrEqual(expected.activeProjects);
  });

  test('an active stage that no read returns raises DATA INCOMPLETE naming its project', async ({ page, request }) => {
    const { named } = await mockState(request);
    await hideModules(request, [named.alphaB]);

    await loadGrid(page);
    const banner = page.getByTestId('integrity-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('GET /api/v1/Modules: 1 stage(s) on 1 active project(s) could not be read (ProjectID 1)');
  });

  test('a gap limited to archived projects is not a banner', async ({ page, request }) => {
    const { expected, named } = await mockState(request);
    await hideModules(request, [named.zuluZ]);

    await loadGrid(page);
    await expect(page.getByTestId('integrity-banner')).toBeHidden();
    await expect(page.getByTestId('meta-stages')).toHaveText(expected.active.stages.toLocaleString('en-US'));

    // Shown archived projects say, neutrally, that one of their stages is absent.
    await page.getByTestId('toggle-archived').check();
    await expect(page.getByTestId('warning-banner')).toContainText('1 stage(s) on 1 archived project(s) did not arrive');
    await expect(page.getByTestId('integrity-banner')).toBeHidden();
    await search(page, 'Zulu Archive');
    await expect(page.getByTestId('footer-count')).toHaveText('0');
  });
});
