import { expect, test } from '@playwright/test';
import { expectNoErrorCopy, loadGrid, mockState, moduleRow, search, waitForGrid } from './support/grid';

test.describe('completeness and organisation filter', () => {
  test('no truncation: every active stage arrives and the footer count matches the fixture', async ({ page, request }) => {
    const { expected } = await mockState(request);
    // Well past the old 200 x 100 = 20,000 ceiling, served 750 per page.
    expect(expected.totalModules).toBeGreaterThan(20_000);

    await loadGrid(page);
    await expectNoErrorCopy(page);
    await expect(page.getByTestId('meta-stages')).toHaveText(expected.active.stages.toLocaleString('en-US'));
    await expect(page.getByTestId('meta-projects')).toHaveText(expected.activeProjects.toLocaleString('en-US'));
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
    // The 500-row render cap is a neutral status-line note, not a banner.
    expect(expected.active.gross).toBeGreaterThan(500);
    await expect(page.getByTestId('row-count')).toHaveText(
      `Showing 500 of ${expected.active.gross.toLocaleString('en-US')} — totals and CSV include all`);
    await expect(page.locator('.notice', { hasText: 'Showing the first' })).toHaveCount(0);
  });

  test('organisation filter: All, SJB MEL, SJB SYD', async ({ page, request }) => {
    const { expected, named } = await mockState(request);
    await loadGrid(page);

    const office = page.getByTestId('filter-office');
    await expect(office.locator('option')).toHaveText(['All organisations', 'SJB MEL', 'SJB SYD']);
    await expect(office).toHaveValue('all');

    await office.selectOption({ label: 'SJB MEL' });
    await waitForGrid(page);
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.mel.gross));
    await expect(page.getByTestId('meta-stages')).toHaveText(expected.mel.stages.toLocaleString('en-US'));
    await search(page, 'Alpha Tower'); // a Sydney project
    await expect(page.getByTestId('footer-count')).toHaveText('0');
    await search(page, 'Bravo House'); // a Melbourne project
    await expect(moduleRow(page, named.bravoA)).toBeVisible();

    await search(page, '');
    await office.selectOption({ label: 'SJB SYD' });
    await waitForGrid(page);
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.syd.gross));
    await expect(page.getByTestId('meta-stages')).toHaveText(expected.syd.stages.toLocaleString('en-US'));

    await office.selectOption({ label: 'All organisations' });
    await waitForGrid(page);
    await expect(page.getByTestId('footer-count')).toHaveText(String(expected.active.gross));
    expect(expected.mel.gross + expected.syd.gross).toBe(expected.active.gross);
  });
});
