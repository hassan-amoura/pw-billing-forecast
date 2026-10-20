import { expect, test } from '@playwright/test';
import { loadGrid, mockState, moduleRow, search } from './support/grid';

test('Stage No column is filled from the "Stage No" module custom field and blank when unset', async ({ page, request }) => {
  const { named } = await mockState(request);
  await loadGrid(page);

  // The header is the tenant's own label from MODULE_CUSTOM_FIELD_LABELS.
  await expect(page.locator('thead th[data-col="stageNumber"]')).toContainText('Stage No');
  await expect(page.locator('thead th[data-col="fixedHourly"]')).toContainText('Des / Del');
  // Custom-field problems are logged at server startup, never bannered.
  await expect(page.getByTestId('custom-field-notice')).toHaveCount(0);

  await search(page, 'Alpha Tower');
  await expect(moduleRow(page, named.alphaA).locator('td[data-col="stageNumber"]')).toHaveText('01.10');
  await expect(moduleRow(page, named.alphaB).locator('td[data-col="stageNumber"]')).toHaveText('');
  await expect(moduleRow(page, named.alphaA).locator('td[data-col="riskStatus"]')).toHaveText('Low');
  await expect(moduleRow(page, named.alphaA).locator('td[data-col="fixedHourly"]')).toHaveText('Des');

  await search(page, 'Bravo House');
  await expect(moduleRow(page, named.bravoA).locator('td[data-col="stageNumber"]')).toHaveText('02.01');
});
