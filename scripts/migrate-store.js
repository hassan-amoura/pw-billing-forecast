'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createStorage, requireStorageConfig } = require('../storage');

function usage() {
  console.error('Usage: npm run migrate:store -- [--dry-run] [path/to/store.json]');
}

function parseArgs(args) {
  let dryRun = false;
  let sourcePath = path.join(__dirname, '..', 'data', 'store.json');
  let sourceSpecified = false;
  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (!arg.startsWith('-') && !sourceSpecified) {
      sourcePath = path.resolve(arg);
      sourceSpecified = true;
    } else {
      usage();
      throw new Error(`unknown or duplicate argument: ${arg}`);
    }
  }
  return { dryRun, sourcePath };
}

async function main() {
  const { dryRun, sourcePath } = parseArgs(process.argv.slice(2));
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const storage = createStorage(requireStorageConfig());
  try {
    const result = await storage.migrateJsonStore(source, { dryRun });
    console.log(JSON.stringify({ sourcePath, ...result }, null, 2));
  } finally {
    await storage.close();
  }
}

main().catch((err) => {
  console.error(`Store migration failed: ${String(err.message || err)}`);
  process.exitCode = 1;
});
