'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createStorage, inspectJsonStore, requireStorageConfig } = require('../storage');

function usage() {
  console.error('Usage: npm run backup:export -- [--stdout | path/to/backup.json]');
}

function defaultOutputPath(instanceId) {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(__dirname, '..', 'backups', `store-${safeInstance}-${stamp}.json`);
}

function parseArgs(args, instanceId) {
  if (args.length > 1 || (args[0]?.startsWith('-') && args[0] !== '--stdout')) {
    usage();
    throw new Error('expected at most one output path or --stdout');
  }
  if (args[0] === '--stdout') return { stdout: true };
  return { stdout: false, outputPath: args[0] ? path.resolve(args[0]) : defaultOutputPath(instanceId) };
}

async function main() {
  const config = requireStorageConfig();
  const destination = parseArgs(process.argv.slice(2), config.instanceId);
  const storage = createStorage(config);
  try {
    const backup = await storage.exportJsonStore();
    const counts = inspectJsonStore(backup);
    const json = `${JSON.stringify(backup, null, 2)}\n`;
    if (destination.stdout) {
      process.stdout.write(json);
      return;
    }
    fs.mkdirSync(path.dirname(destination.outputPath), { recursive: true });
    fs.writeFileSync(destination.outputPath, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ outputPath: destination.outputPath, ...counts }, null, 2));
  } finally {
    await storage.close();
  }
}

main().catch((err) => {
  console.error(`Backup export failed: ${String(err.message || err)}`);
  process.exitCode = 1;
});
