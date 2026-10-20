import { expect, test } from '@playwright/test';
import { MOCK_URL } from './support/env';
import { loadGrid, mockState, moduleRow, search } from './support/grid';

// Runs only in the "writes-off" project: the app instance with ALLOW_WRITES=false.
test('ALLOW_WRITES=false renders month cells read-only and refuses forecast writes', async ({ page, request }) => {
  const { named } = await mockState(request);
  await loadGrid(page);
  await expect(page.getByTestId('writes-chip')).toHaveText('writes: off');
  await expect(page.getByTestId('readonly-notice')).toBeVisible();

  await search(page, 'Alpha Tower');
  const cell = moduleRow(page, named.alphaA).locator(`input[data-month="${named.forecastMonth}"]`);
  await expect(cell).toBeDisabled();

  const res = await page.request.post('/api/forecast', {
    data: {
      moduleID: named.alphaA,
      month: named.forecastMonth,
      amount: 1,
      selectedProjectworksUserID: '11',
      context: { from: 3000 },
    },
  });
  expect(res.status()).toBe(403);
  expect(await (await request.get(`${MOCK_URL}/__mock/forecast-sets`)).json()).toEqual([]);
});
