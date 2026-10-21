import { expect, test } from '@playwright/test';
import {
  delayModules, expectNoErrorCopy, loadGrid, mockState, resetMock, setOutage, startFullRefresh, waitForGrid,
} from './support/grid';

/**
 * Refresh progress and failure. A refresh that fails leaves the last good
 * snapshot on screen, and the only thing the page says about it is the
 * neutral "Last refreshed hh:mm".
 */
test.describe('refresh progress and failure', () => {
  test.afterEach(async ({ request }) => {
    await setOutage(request, false);
    await resetMock(request);
  });

  test('a full refresh shows "Refreshing… N of M projects" over the grid already on screen', async ({ page, request }) => {
    const { expected } = await mockState(request);
    await loadGrid(page);
    await delayModules(request, 300);
    await startFullRefresh(request, { wait: false });

    await page.goto('/'); // follows the refresh already running for this range
    await expect(page.getByTestId('grid')).toBeVisible();
    const progress = page.getByTestId('refresh-progress');
    await expect(page.locator('#s-progress-text')).toHaveText(new RegExp(`^Refreshing… \\d[\\d,]* of ${expected.activeProjects} projects$`));
    await expect(page.getByTestId('load-button')).toHaveText('Refreshing…');
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));

    await waitForGrid(page);
    await expect(progress).toBeHidden();
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
  });

  test('a failed refresh keeps serving the last good data, with only "Last refreshed hh:mm" on screen', async ({ page, request }) => {
    const { expected } = await mockState(request);
    await loadGrid(page);
    const refreshed = page.getByTestId('last-refreshed');
    await expect(refreshed).toHaveText(/^Last refreshed \d{1,2}:\d{2}/);
    const before = await refreshed.innerText();

    await setOutage(request, true);
    await page.getByTestId('load-button').click();
    await expect(page.getByTestId('load-button')).toHaveText('Refreshing…');
    await waitForGrid(page);

    await expect(refreshed).toHaveText(before);
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
    await expectNoErrorCopy(page);
    await expect(page.locator('#toast.show')).toHaveCount(0);

    // Reloading while Projectworks is still down: the cache is served at once.
    await page.reload();
    await waitForGrid(page);
    await expect(refreshed).toHaveText(before);
    await expectNoErrorCopy(page);
  });
});
