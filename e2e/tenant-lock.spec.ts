import { expect, test } from '@playwright/test';
import { spawn } from 'child_process';
import path from 'path';
import { appEnv } from './support/env';

/** Boot the app against the mock with a given lock and collect how it exits. */
function boot(lock: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['../server.js'], {
      cwd: path.join(__dirname),
      env: appEnv(4319, { PW_TENANT_LOCK: lock, INSTANCE_ID: 'e2e-lock' }),
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server did not exit:\n${output}`)); }, 30_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test.describe('tenant lock', () => {
  test('refuses to start against a tenant whose offices do not match PW_TENANT_LOCK', async () => {
    const { code, output } = await boot('Some Other Tenant');
    expect(code).toBe(1);
    expect(output).toContain('TENANT MISMATCH');
    expect(output).toContain('"SJB MEL", "SJB SYD"');
    expect(output).not.toContain('listening on');
  });

  test('a lock naming only SJB SYD refuses a tenant that also has SJB MEL projects', async () => {
    const { code, output } = await boot('SJB SYD');
    expect(code).toBe(1);
    expect(output).toContain('Unexpected office(s):       "SJB MEL"');
  });
});
