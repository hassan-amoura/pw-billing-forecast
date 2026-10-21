import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { APP_WRITES_ON_PORT, GATE, MOCK_URL } from './env';

export interface Counts { stages: number; gross: number }
export interface MockState {
  expected: {
    totalModules: number;
    totalProjects: number;
    archivedProjects: number;
    activeProjects: number;
    active: Counts;
    syd: Counts;
    mel: Counts;
  };
  named: {
    alphaA: number; alphaB: number; alphaC: number; bravoA: number; zuluZ: number; forecastMonth: string;
    archivedProjectIDs: number[];
  };
}

/** Expected counts and named module IDs, computed by the mock from the data it serves. */
export async function mockState(request: APIRequestContext): Promise<MockState> {
  const res = await request.get(`${MOCK_URL}/__mock/health`);
  expect(res.ok()).toBeTruthy();
  return res.json();
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

export interface ModuleRequests {
  modulesPaged: number; modulesByProject: number; modulesByID: number; modulesModifiedSince: number; projectIDs: number[];
}
export async function moduleRequests(request: APIRequestContext): Promise<ModuleRequests> {
  return (await request.get(`${MOCK_URL}/__mock/requests`)).json();
}

/** The next `times` module reads of each project answer `status`. */
export async function failProjects(request: APIRequestContext, projectIDs: number[], status: number, times: number | 'always'): Promise<void> {
  expect((await request.post(`${MOCK_URL}/__mock/fail?projects=${projectIDs.join(',')}&status=${status}&times=${times}`)).ok()).toBeTruthy();
}

/** The next `times` module reads of each project drop one row while still counting it. */
export async function shortProjects(request: APIRequestContext, projectIDs: number[], times: number | 'always'): Promise<void> {
  expect((await request.post(`${MOCK_URL}/__mock/short?projects=${projectIDs.join(',')}&times=${times}`)).ok()).toBeTruthy();
}

/** Every Projectworks GET answers 503 until switched off. */
export async function setOutage(request: APIRequestContext, on: boolean): Promise<void> {
  expect((await request.post(`${MOCK_URL}/__mock/outage?on=${on ? 1 : 0}`)).ok()).toBeTruthy();
}

/** Edit a module in "Projectworks": new name, bumped ModifiedDateUTC. */
export async function renameModule(request: APIRequestContext, moduleID: number, name: string): Promise<void> {
  expect((await request.post(`${MOCK_URL}/__mock/touch?module=${moduleID}&name=${encodeURIComponent(name)}`)).ok()).toBeTruthy();
}

/** Delete a module in "Projectworks" (and from its project's Modules list). */
export async function deleteModule(request: APIRequestContext, moduleID: number): Promise<void> {
  expect((await request.post(`${MOCK_URL}/__mock/delete?module=${moduleID}`)).ok()).toBeTruthy();
}

/** The default window the UI opens with: this month and the next eleven. */
export function defaultWindow(): { start: string; end: string } {
  const now = new Date();
  const ym = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 15);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  return { start: ym(0), end: ym(11) };
}

const APP_URL = `http://127.0.0.1:${APP_WRITES_ON_PORT}`;
const AUTH = { Authorization: 'Basic ' + Buffer.from(`${GATE.username}:${GATE.password}`).toString('base64') };

/**
 * Start a FULL refresh of the default window on the writes-on app (Load data
 * is incremental once a full sync exists). Returns without waiting unless
 * `wait` is set.
 */
export async function startFullRefresh(request: APIRequestContext, { wait = true } = {}): Promise<void> {
  const { start, end } = defaultWindow();
  const res = await request.post(`${APP_URL}/api/grid/refresh?start=${start}&end=${end}&full=1`, { headers: AUTH });
  expect(res.ok()).toBeTruthy();
  if (!wait) return;
  await expect.poll(async () =>
    (await (await request.get(`${APP_URL}/api/grid/refresh?start=${start}&end=${end}`, { headers: AUTH })).json()).status,
  { timeout: 60_000 }).toBe('done');
}

/** Nothing on screen reads as an error: no alert roles and no error vocabulary. */
export async function expectNoErrorCopy(page: Page): Promise<void> {
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/incomplete|failed|error|missing|could not|unable|retry|warning|archived/i);
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
