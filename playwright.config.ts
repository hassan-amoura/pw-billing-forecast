import { defineConfig, devices } from '@playwright/test';
import {
  APP_WRITES_OFF_PORT, APP_WRITES_ON_PORT, GATE, MOCK_PORT, MOCK_URL, PG_PORT, appEnv,
} from './e2e/support/env';

/**
 * End-to-end tests against a MOCKED Projectworks API only (e2e/mock-pw).
 * Four processes, started in order: a throwaway Postgres, the mock API, and
 * two instances of the app — one with ALLOW_WRITES=true (production config)
 * and one with ALLOW_WRITES=false. The app runs with cwd=e2e/ so dotenv can
 * never load a developer's real .env.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // the specs share one mock tenant and one forecast store
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  outputDir: 'e2e-results',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'writes-on',
      testIgnore: /readonly\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${APP_WRITES_ON_PORT}`, httpCredentials: GATE },
    },
    {
      name: 'writes-off',
      testMatch: /readonly\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${APP_WRITES_OFF_PORT}`, httpCredentials: GATE },
    },
  ],
  webServer: [
    {
      command: 'node e2e/support/postgres.js',
      port: PG_PORT,
      env: { E2E_PG_PORT: String(PG_PORT), PG_BIN: process.env.PG_BIN ?? '', PATH: process.env.PATH ?? '' },
      reuseExistingServer: false,
      timeout: 60_000,
      // Stop Postgres cleanly. Killed outright, it leaves its System V shared
      // memory segment behind; macOS allows 32, so the suite stopped starting
      // after ~32 runs ("could not create shared memory segment").
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
    {
      command: 'node e2e/mock-pw/server.js',
      url: `${MOCK_URL}/__mock/health`,
      env: { MOCK_PW_PORT: String(MOCK_PORT), PATH: process.env.PATH ?? '' },
      reuseExistingServer: false,
    },
    {
      command: 'node ../server.js',
      cwd: './e2e',
      url: `http://127.0.0.1:${APP_WRITES_ON_PORT}/healthz`,
      env: appEnv(APP_WRITES_ON_PORT, { ALLOW_WRITES: 'true' }),
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node ../server.js',
      cwd: './e2e',
      url: `http://127.0.0.1:${APP_WRITES_OFF_PORT}/healthz`,
      env: appEnv(APP_WRITES_OFF_PORT, { ALLOW_WRITES: 'false' }),
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
