import { expect, test } from '@playwright/test';
import { MOCK_URL } from './support/env';
import { loadGrid, mockState, moduleRow, resetMock, search } from './support/grid';

test.describe('ALLOW_WRITES=true', () => {
  test.beforeEach(async ({ request }) => resetMock(request));
  test.afterEach(async ({ request }) => resetMock(request));

  test('month cells are editable and an edit sends the correct POST /Forecasts/Set payload', async ({ page, request }) => {
    const { named } = await mockState(request);
    await loadGrid(page);
    await expect(page.getByTestId('writes-chip')).toHaveText('writes: on');
    await expect(page.getByTestId('readonly-notice')).toBeHidden();

    await page.getByTestId('user-select').selectOption({ label: 'Ada Lovelace (ada@example.test)' });
    await search(page, 'Alpha Tower');
    const cell = moduleRow(page, named.alphaA).locator(`input[data-month="${named.forecastMonth}"]`);
    await expect(cell).toBeEditable();
    await expect(cell).toHaveValue('3000');

    await cell.fill('4500');
    await cell.press('Enter');
    await expect(cell.locator('xpath=..')).toHaveClass(/saved/);

    await expect.poll(async () => (await request.get(`${MOCK_URL}/__mock/forecast-sets`)).json()).toEqual([{
      moduleID: named.alphaA,
      date: `${named.forecastMonth}-01`,
      amount: 4500,
      comment: 'Set by Ada Lovelace via PW Billing Forecast tool',
    }]);

    // The write is audited as having reached Projectworks.
    await page.getByTestId('tab-audit').click();
    const entry = page.locator('#audit-body tr').first();
    await expect(entry).toContainText('forecast.set');
    await expect(entry).toContainText('Alpha Tower');
    await expect(entry).toContainText('Projectworks ✓');

    // The served snapshot was patched: reopening the page, with no refresh,
    // shows the written value rather than the one read before the edit.
    await page.reload();
    await search(page, 'Alpha Tower');
    await expect(moduleRow(page, named.alphaA).locator(`input[data-month="${named.forecastMonth}"]`)).toHaveValue('4500');
  });

  test('consultant (non-services) modules are never written to Projectworks', async ({ page, request }) => {
    const { named } = await mockState(request);
    await loadGrid(page);
    const res = await page.request.post('/api/forecast', {
      data: {
        moduleID: named.alphaC,
        month: named.forecastMonth,
        amount: 100,
        selectedProjectworksUserID: '11',
        context: { from: '' },
      },
    });
    expect(res.status()).toBe(403);
    expect(await (await request.get(`${MOCK_URL}/__mock/forecast-sets`)).json()).toEqual([]);
  });
});
