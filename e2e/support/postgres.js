'use strict';

/**
 * Throwaway Postgres for the end-to-end run: initdb into a temp directory,
 * run the server in the foreground on E2E_PG_PORT, delete everything on exit.
 * Playwright starts this as a webServer and waits for the port.
 *
 * Needs the Postgres server binaries (initdb, postgres) on PATH, or
 * PG_BIN pointing at their directory (e.g. /opt/homebrew/opt/postgresql@18/bin).
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.E2E_PG_PORT || 4313);
const bin = (name) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-forecast-e2e-pg-'));
const data = path.join(dir, 'data');

const init = spawnSync(bin('initdb'), ['-D', data, '-U', 'e2e', '--auth=trust', '--no-sync', '-E', 'UTF8'], { encoding: 'utf8' });
if (init.status !== 0) {
  console.error(`initdb failed (is Postgres installed? set PG_BIN):\n${init.stderr || init.error}`);
  process.exit(1);
}

const pg = spawn(bin('postgres'), [
  '-D', data, '-p', String(PORT), '-k', dir,
  '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off', '-c', 'full_page_writes=off',
], { stdio: 'inherit' });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { pg.kill('SIGINT'); });
}
pg.on('exit', (code) => { cleanup(); process.exit(code ?? 0); });
