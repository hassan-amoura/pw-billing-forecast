import { expect, test } from '@playwright/test';
import { loadGrid, mockState, moduleRow, search } from './support/grid';

test.describe('status filters', () => {
  test('Gross Fees to Date counts only "Finance Approved" invoices', async ({ page, request }) => {
    const { named } = await mockState(request);
    await loadGrid(page);
    await search(page, 'Alpha Tower');
    // Fixture: 12,000 Finance Approved + 5,000 Draft + 700 "Approved" on Stage A.
    await expect(moduleRow(page, named.alphaA).locator('td[data-col="feesToDate"]')).toHaveText('A$12,000.00');
    await expect(moduleRow(page, named.alphaB).locator('td[data-col="feesToDate"]')).toHaveText('A$0.00');
  });

  test('Consultant Fees to Date counts only Approved expense claims', async ({ page, request }) => {
    const { named } = await mockState(request);
    await loadGrid(page);
    // EXPENSE_STATUS_CODES=Approved resolves to status ID 4; no unresolved-status warning.
    await expect(page.getByTestId('warning-banner')).toBeHidden();
    await page.getByTestId('tab-consultant').click();
    await search(page, 'Alpha Tower');
    // Fixture: 2,500 approved (ID 4) + 9,999 submitted (ID 2).
    await expect(moduleRow(page, named.alphaC).locator('td[data-col="feesToDate"]')).toHaveText('A$2,500.00');
  });
});
