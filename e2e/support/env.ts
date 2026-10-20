/**
 * Ports and environment for the end-to-end run. Every Projectworks URL points
 * at the local mock; no variable here can reach a real tenant.
 */

export const MOCK_PORT = 4310;
export const APP_WRITES_ON_PORT = 4311;
export const APP_WRITES_OFF_PORT = 4312;
export const PG_PORT = 4313;

export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
export const GATE = { username: 'sjb-e2e', password: 'e2e-gate-password' };

/**
 * The production variable set from Render, with the tenant lock listing both
 * SJB organisations and credentials/URLs swapped for the mock and a throwaway
 * database. Optional variables are pinned empty so nothing leaks in from a
 * developer's shell.
 */
export function appEnv(port: number, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    PORT: String(port),
    ALLOW_WRITES: 'true',
    AUTH_MODE: 'basic',
    AUTH_DISABLED: 'false',
    PW_USERNAME: 'e2e-key',
    PW_PASSWORD: 'e2e-secret',
    PW_AUTH_HEADER_NAME: '',
    PW_AUTH_HEADER_VALUE: '',
    PW_BASE_URL: MOCK_URL,
    PW_APP_BASE_URL: 'https://sjb.projectworksapp.com/',
    PW_REQUEST_TIMEOUT_MS: '30000',
    PW_TENANT_LOCK: 'SJB MEL,SJB SYD',
    BASIC_AUTH_USER: GATE.username,
    BASIC_AUTH_PASSWORD: GATE.password,
    DATABASE_URL: `postgres://e2e@127.0.0.1:${PG_PORT}/postgres`,
    DATABASE_SSL_MODE: 'disable',
    INSTANCE_ID: `e2e-${port}`,
    AUDIT_RETENTION_LIMIT: '',
    SEED_DEMO_DATA: 'false',
    DEFAULT_STAGE_SORT: 'stageName',
    EXPENSE_STATUS_CODES: 'Approved',
    INVOICE_STATUS_CODES: 'Finance Approved',
    MODULE_CUSTOM_FIELD_LABELS: 'Stage No,Risk Status,Des / Del',
    MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID: '',
    ARCHIVED_PROJECT_STATUSES: '',
    STARTUP_DIAGNOSTICS: 'false',
    ...overrides,
  };
}
