import { expect, test } from '@playwright/test';
import { loadGrid, mockState, resetMock, shiftModulePages } from './support/grid';

/**
 * Production saw 27,779 modules come back as 27,651 unique: 128 records slid
 * across page boundaries between concurrent page reads, arriving twice while
 * their neighbours never arrived. The mock reproduces that exactly — pages 3
 * and 7 served 64 records early — and the app must dedupe and re-fetch.
 */
test.describe('pagination with records shifting between pages', () => {
  test.afterEach(async ({ request }) => {
    await resetMock(request);
  });

  test('a transient shift is recovered: every stage arrives and no incomplete banner shows', async ({ page, request }) => {
    const { expected } = await mockState(request);
    await shiftModulePages(request, [3, 7], 64, 1);

    await loadGrid(page);
    await expect(page.getByTestId('load-error')).toBeHidden();
    await expect(page.getByTestId('integrity-banner')).toBeHidden();
    await expect(page.getByTestId('meta-stages')).toHaveText(expected.active.stages.toLocaleString('en-US'));
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
  });

  test('a shift that never settles still raises DATA INCOMPLETE', async ({ page, request }) => {
    await shiftModulePages(request, [3, 7], 64, 'always');

    await loadGrid(page);
    const banner = page.getByTestId('integrity-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('GET /api/v1/Modules');
    await expect(banner).toContainText(/fetched [\d,]+ of [\d,]+ records/);
  });
});
