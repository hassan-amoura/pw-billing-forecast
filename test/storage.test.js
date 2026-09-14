'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectJsonStore, readStorageConfig } = require('../storage');

test('Postgres storage configuration fails closed and accepts an explicit valid configuration', () => {
  const missing = readStorageConfig({});
  assert.deepEqual(missing.errors, [
    'DATABASE_URL is not set (Postgres connection string).',
    'DATABASE_SSL_MODE must be set to "disable", "require", or "verify-full".',
    'INSTANCE_ID is not set (stable identifier for this deployment and tenant).',
  ]);

  const valid = readStorageConfig({
    DATABASE_URL: 'postgresql://example:secret@db.example.test:5432/forecast',
    DATABASE_SSL_MODE: 'verify-full',
    INSTANCE_ID: 'sjb-production',
    AUDIT_RETENTION_LIMIT: '5000',
  });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.auditRetentionLimit, 5000);
});

test('legacy JSON migration inspection validates IDs, months and audit timestamps', () => {
  const summary = inspectJsonStore({
    nextLineID: 3,
    supplierLines: [
      { id: 2, moduleID: 10, supplier: 'Consultant', description: '', months: { '2026-08': 50 } },
    ],
    audit: [
      { time: '2026-09-14T00:00:00.000Z', action: 'supplier.set', from: 0, to: 50, retainedNote: 'yes' },
    ],
  });

  assert.equal(summary.supplierLines, 1);
  assert.equal(summary.monthRows, 1);
  assert.equal(summary.auditEntries, 1);
  assert.deepEqual(summary.extraKeys, ['retainedNote']);

  assert.throws(() => inspectJsonStore({
    supplierLines: [{ id: 1, moduleID: 10, supplier: 'A', description: '', months: { August: 5 } }],
    audit: [],
  }), /invalid month/);
});
