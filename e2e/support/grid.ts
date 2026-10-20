import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { MOCK_URL } from './env';

export interface Counts { stages: number; gross: number }
export interface MockState {
  expected: {
    totalModules: number;
    totalProjects: number;
    archivedProjects: number;
    activeProjects: number;
    active: Counts;
    withArchived: Counts;
    syd: Counts;
    mel: Counts;
  };
  named: { alphaA: number; alphaB: number; alphaC: number; bravoA: number; zuluZ: number; forecastMonth: string };
}

/** Expected counts and named module IDs, computed by the mock from the data it serves. */
export async function mockState(request: APIRequestContext): Promise<MockState> {
  const res = await request.get(`${MOCK_URL}/__mock/health`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Make /Modules serve `pages` shifted by `by` records for their next `times` requests. */
export async function shiftModulePages(
  request: APIRequestContext, pages: number[], by: number, times: number | 'always',
): Promise<void> {
  const res = await request.post(`${MOCK_URL}/__mock/shift?pages=${pages.join(',')}&by=${by}&times=${times}`);
  expect(res.ok()).toBeTruthy();
}

/** /Modules sorted by ModuleName with ties reshuffled on every request, like the live API. */
export async function setUnstableModuleOrder(request: APIRequestContext, on: boolean): Promise<void> {
  expect((await request.post(`${MOCK_URL}/__mock/unstable?on=${on ? 1 : 0}`)).ok()).toBeTruthy();
}

/** Count these modules in x-total-count but never serve them, by any query. */
export async function hideModules(request: APIRequestContext, moduleIDs: number[]): Promise<void> {
  expect((await request.post(`${MOCK_URL}/__mock/hide?modules=${moduleIDs.join(',')}`)).ok()).toBeTruthy();
}

/** Delay every /Modules response, so a refresh stays in flight long enough to watch. */
export async function delayModules(request: APIRequestContext, ms: number): Promise<void> {
  expect((await request.post(`${MOCK_URL}/__mock/delay?ms=${ms}`)).ok()).toBeTruthy();
}

export async function moduleRequests(request: APIRequestContext): Promise<{ modulesPaged: number; modulesByProject: number; modulesByID: number }> {
  return (await request.get(`${MOCK_URL}/__mock/requests`)).json();
}

export async function resetMock(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${MOCK_URL}/__mock/reset`)).ok()).toBeTruthy();
}

/**
 * Open the app and press Load data (a background refresh from Projectworks),
 * waiting until the refreshed grid is rendered and idle.
 */
export async function loadGrid(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('load-button').click();
  await waitForGrid(page);
}

export async function waitForGrid(page: Page): Promise<void> {
  await expect(page.getByTestId('grid')).toBeVisible();
  await expect(page.getByTestId('grid')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('load-button')).toHaveText('Load data');
}

export function moduleRow(page: Page, moduleID: number) {
  return page.locator(`[data-testid="grid-row"][data-module-id="${moduleID}"]`);
}

export async function search(page: Page, text: string): Promise<void> {
  await page.getByTestId('filter-search').fill(text);
}
