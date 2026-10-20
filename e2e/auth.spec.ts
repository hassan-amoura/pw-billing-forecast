import { expect, test } from '@playwright/test';
import { GATE } from './support/env';

test.describe('basic auth gate', () => {
  // Plain fetch: Playwright request contexts inherit the configured credentials.
  test('rejects requests without credentials or with a wrong password', async ({ baseURL }) => {
    const anonymous = (path: string, init?: RequestInit) => fetch(`${baseURL}${path}`, init);
    const page = await anonymous('/');
    expect(page.status).toBe(401);
    expect(page.headers.get('www-authenticate')).toContain('Basic');
    expect((await anonymous('/api/health')).status).toBe(401);
    expect((await anonymous('/api/grid?start=2026-01&end=2026-12')).status).toBe(401);
    expect((await anonymous('/api/forecast', { method: 'POST', body: '{}' })).status).toBe(401);
    // The single unauthenticated route returns no tenant data.
    const health = await anonymous('/healthz');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const wrong = await anonymous('/', {
      headers: { Authorization: `Basic ${Buffer.from(`${GATE.username}:not-the-password`).toString('base64')}` },
    });
    expect(wrong.status).toBe(401);
    const right = await anonymous('/', {
      headers: { Authorization: `Basic ${Buffer.from(`${GATE.username}:${GATE.password}`).toString('base64')}` },
    });
    expect(right.status).toBe(200);
  });

  test('valid credentials open the app', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('load-button')).toBeVisible();
    await expect(page.locator('#chip-tenant')).toHaveText('SJB MEL + SJB SYD');
  });
});
