'use strict';

const fs = require('fs');
const { Pool } = require('pg');

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const AUDIT_FIELDS = new Set([
  'time',
  'user',
  'projectworksUserID',
  'action',
  'project',
  'stage',
  'supplier',
  'moduleID',
  'month',
  'from',
  'to',
  'synced',
  'target',
  'error',
]);

function readStorageConfig(env = process.env) {
  const connectionString = String(env.DATABASE_URL || '').trim();
  const sslMode = String(env.DATABASE_SSL_MODE || '').trim().toLowerCase();
  const instanceId = String(env.INSTANCE_ID || '').trim();
  const retentionText = String(env.AUDIT_RETENTION_LIMIT || '').trim();
  const errors = [];

  if (!connectionString) {
    errors.push('DATABASE_URL is not set (Postgres connection string).');
  } else {
    try {
      const parsed = new URL(connectionString);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('wrong protocol');
    } catch {
      errors.push('DATABASE_URL is not a valid postgres:// or postgresql:// connection string.');
    }
  }

  if (!['disable', 'require'].includes(sslMode)) {
    errors.push('DATABASE_SSL_MODE must be set to "disable" or "require".');
  }
  if (!instanceId) {
    errors.push('INSTANCE_ID is not set (stable identifier for this deployment and tenant).');
  }
  if (retentionText && (!/^[1-9]\d*$/.test(retentionText) || !Number.isSafeInteger(Number(retentionText)))) {
    errors.push('AUDIT_RETENTION_LIMIT must be a positive safe integer when set.');
  }

  return {
    connectionString,
    sslMode,
    instanceId,
    auditRetentionLimit: retentionText ? Number(retentionText) : null,
    errors,
  };
}

function requireStorageConfig(env = process.env) {
  const config = readStorageConfig(env);
  if (config.errors.length) {
    const err = new Error(config.errors.join('\n'));
    err.code = 'ESTORAGECONFIG';
    err.configErrors = config.errors;
    throw err;
  }
  return config;
}

function asSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} is outside JavaScript's safe integer range`);
  return number;
}

function asFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} is not a finite number`);
  return number;
}

function nullableAmount(value, label) {
  if (value === '' || value == null) return null;
  return asFiniteNumber(value, label);
}

function isoTime(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is not a valid timestamp`);
  return date.toISOString();
}

function nextLineIDFromJsonStore(raw) {
  const maxID = raw.supplierLines.reduce((maximum, line) => Math.max(maximum, Number(line.id) || 0), 0);
  if (raw.nextLineID == null) return maxID + 1;
  const declared = asSafeInteger(raw.nextLineID, 'nextLineID');
  if (declared < 1) throw new Error('nextLineID must be positive');
  return Math.max(declared, maxID + 1);
}

function inspectJsonStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('store JSON top level must be an object');
  }
  if (!Array.isArray(raw.supplierLines)) throw new Error('store JSON supplierLines must be an array');
  if (!Array.isArray(raw.audit)) throw new Error('store JSON audit must be an array');

  const lineIDs = new Set();
  let monthRows = 0;
  for (const [index, line] of raw.supplierLines.entries()) {
    const prefix = `supplierLines[${index}]`;
    if (!line || typeof line !== 'object' || Array.isArray(line)) throw new Error(`${prefix} must be an object`);
    const id = asSafeInteger(line.id, `${prefix}.id`);
    if (id < 1) throw new Error(`${prefix}.id must be positive`);
    if (lineIDs.has(id)) throw new Error(`${prefix}.id duplicates supplier line ${id}`);
    lineIDs.add(id);
    asSafeInteger(line.moduleID, `${prefix}.moduleID`);
    if (typeof line.supplier !== 'string') throw new Error(`${prefix}.supplier must be a string`);
    if (typeof line.description !== 'string') throw new Error(`${prefix}.description must be a string`);
    if (!line.months || typeof line.months !== 'object' || Array.isArray(line.months)) {
      throw new Error(`${prefix}.months must be an object`);
    }
    for (const [month, amount] of Object.entries(line.months)) {
      if (!MONTH_PATTERN.test(month)) throw new Error(`${prefix}.months has invalid month ${JSON.stringify(month)}`);
      asFiniteNumber(amount, `${prefix}.months[${JSON.stringify(month)}]`);
      monthRows += 1;
    }
  }
  nextLineIDFromJsonStore(raw);

  const extraKeys = new Set();
  let extraRecords = 0;
  for (const [index, entry] of raw.audit.entries()) {
    const prefix = `audit[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${prefix} must be an object`);
    isoTime(entry.time, `${prefix}.time`);
    if (!entry.action) throw new Error(`${prefix}.action is required`);
    nullableAmount(entry.from, `${prefix}.from`);
    nullableAmount(entry.to, `${prefix}.to`);
    const keys = Object.keys(entry).filter((key) => !AUDIT_FIELDS.has(key));
    if (keys.length) {
      extraRecords += 1;
      for (const key of keys) extraKeys.add(key);
    }
  }

  return {
    supplierLines: raw.supplierLines.length,
    monthRows,
    auditEntries: raw.audit.length,
    extraRecords,
    extraKeys: [...extraKeys].sort(),
  };
}

function createStorage(config) {
  if (!config || config.errors?.length) throw new Error('createStorage requires validated database configuration');

  const pool = new Pool({
    connectionString: config.connectionString,
    ssl: config.sslMode === 'require' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    console.error(`Unexpected idle Postgres connection error: ${String(err.message || err)}`);
  });

  async function ensureSchema(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS supplier_lines (
        id BIGSERIAL PRIMARY KEY,
        module_id INTEGER NOT NULL,
        supplier TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instance_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS supplier_lines_instance_module_idx
      ON supplier_lines (instance_id, module_id)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS supplier_line_months (
        line_id BIGINT NOT NULL REFERENCES supplier_lines(id) ON DELETE CASCADE,
        month TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        amount NUMERIC NOT NULL,
        PRIMARY KEY (line_id, month)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        time TIMESTAMPTZ NOT NULL,
        user_name TEXT,
        projectworks_user_id TEXT,
        action TEXT NOT NULL,
        project TEXT,
        stage TEXT,
        supplier TEXT,
        module_id INTEGER,
        month TEXT,
        amount_from NUMERIC,
        amount_to NUMERIC,
        synced BOOLEAN,
        target TEXT,
        error TEXT,
        instance_id TEXT NOT NULL,
        extra JSONB
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS audit_log_instance_time_idx
      ON audit_log (instance_id, time DESC, id DESC)
    `);
  }

  async function resetSupplierLineSequence(client, minimumNextID = 1) {
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('supplier_lines', 'id'),
        GREATEST(COALESCE(MAX(id), 0), $1::bigint - 1, 1),
        GREATEST(COALESCE(MAX(id), 0), $1::bigint - 1) > 0
      )
      FROM supplier_lines
    `, [minimumNextID]);
  }

  async function seedIfRequested(client, seedDemoData, seedPath) {
    if (!seedDemoData) return { seeded: false, seedLines: 0 };
    await client.query('LOCK TABLE supplier_lines, audit_log IN SHARE ROW EXCLUSIVE MODE');
    const countResult = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM supplier_lines WHERE instance_id = $1)::text AS lines,
         (SELECT COUNT(*) FROM audit_log WHERE instance_id = $1)::text AS audit`,
      [config.instanceId]
    );
    if (Number(countResult.rows[0].lines) !== 0 || Number(countResult.rows[0].audit) !== 0) {
      return { seeded: false, seedLines: 0 };
    }

    let seed;
    try {
      seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      inspectJsonStore(seed);
    } catch (err) {
      console.warn(`seed.json could not be read (${String(err.message || err)}); starting with empty tables.`);
      return { seeded: false, seedLines: 0 };
    }

    const insertedAt = new Date().toISOString();
    for (const line of seed.supplierLines) {
      await client.query(
        `INSERT INTO supplier_lines
           (id, module_id, supplier, description, instance_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [line.id, line.moduleID, line.supplier, line.description, config.instanceId, insertedAt]
      );
      for (const [month, amount] of Object.entries(line.months)) {
        await client.query(
          'INSERT INTO supplier_line_months (line_id, month, amount) VALUES ($1, $2, $3)',
          [line.id, month, amount]
        );
      }
    }
    await resetSupplierLineSequence(client, nextLineIDFromJsonStore(seed));
    return { seeded: true, seedLines: seed.supplierLines.length };
  }

  async function trimAuditLog(limit = config.auditRetentionLimit) {
    if (limit == null) return 0;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('audit retention limit must be a positive integer');
    const result = await pool.query(
      `WITH expired AS (
         SELECT id
         FROM audit_log
         WHERE instance_id = $1
         ORDER BY time DESC, id DESC
         OFFSET $2
       )
       DELETE FROM audit_log AS audit
       USING expired
       WHERE audit.id = expired.id`,
      [config.instanceId, limit]
    );
    return result.rowCount;
  }

  async function initialize(options = {}) {
    const client = await pool.connect();
    let seedResult;
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1');
      await ensureSchema(client);
      seedResult = await seedIfRequested(client, !!options.seedDemoData, options.seedPath);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const trimmedAuditEntries = await trimAuditLog();
    return { ...seedResult, trimmedAuditEntries };
  }

  async function querySupplierLines(queryable, moduleID) {
    const params = [config.instanceId];
    let moduleFilter = '';
    if (moduleID != null) {
      moduleFilter = 'AND line.module_id = $2';
      params.push(asSafeInteger(moduleID, 'moduleID'));
    }
    const result = await queryable.query(
      `SELECT line.id, line.module_id, line.supplier, line.description,
              month.month, month.amount
       FROM supplier_lines AS line
       LEFT JOIN supplier_line_months AS month ON month.line_id = line.id
       WHERE line.instance_id = $1 ${moduleFilter}
       ORDER BY line.id, month.month`,
      params
    );
    const byID = new Map();
    for (const row of result.rows) {
      const id = asSafeInteger(row.id, 'supplier line id');
      if (!byID.has(id)) {
        byID.set(id, {
          id,
          moduleID: asSafeInteger(row.module_id, 'supplier line module id'),
          supplier: row.supplier,
          description: row.description,
          months: {},
        });
      }
      if (row.month != null) {
        byID.get(id).months[row.month] = asFiniteNumber(row.amount, 'supplier month amount');
      }
    }
    return [...byID.values()];
  }

  function auditValues(entry, defaultTime = new Date()) {
    const extra = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!AUDIT_FIELDS.has(key)) extra[key] = value;
    }
    return {
      time: isoTime(entry.time || defaultTime, 'audit time'),
      userName: entry.user == null ? null : String(entry.user),
      projectworksUserID: entry.projectworksUserID == null ? null : String(entry.projectworksUserID),
      action: String(entry.action || ''),
      project: entry.project == null ? null : String(entry.project),
      stage: entry.stage == null ? null : String(entry.stage),
      supplier: entry.supplier == null ? null : String(entry.supplier),
      moduleID: entry.moduleID == null ? null : asSafeInteger(entry.moduleID, 'audit moduleID'),
      month: entry.month == null ? null : String(entry.month),
      amountFrom: nullableAmount(entry.from, 'audit from amount'),
      amountTo: nullableAmount(entry.to, 'audit to amount'),
      synced: entry.synced == null ? null : !!entry.synced,
      target: entry.target == null ? null : String(entry.target),
      error: entry.error == null ? null : String(entry.error),
      extra: Object.keys(extra).length ? extra : null,
    };
  }

  async function insertAudit(queryable, entry, defaultTime) {
    const value = auditValues(entry, defaultTime);
    if (!value.action) throw new Error('audit action is required');
    await queryable.query(
      `INSERT INTO audit_log
         (time, user_name, projectworks_user_id, action, project, stage, supplier,
          module_id, month, amount_from, amount_to, synced, target, error, instance_id, extra)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        value.time,
        value.userName,
        value.projectworksUserID,
        value.action,
        value.project,
        value.stage,
        value.supplier,
        value.moduleID,
        value.month,
        value.amountFrom,
        value.amountTo,
        value.synced,
        value.target,
        value.error,
        config.instanceId,
        value.extra,
      ]
    );
  }

  function rowToAudit(row) {
    const entry = {
      ...(row.extra || {}),
      time: isoTime(row.time, 'stored audit time'),
      user: row.user_name ?? '',
      action: row.action,
      project: row.project ?? '',
      stage: row.stage ?? '',
      supplier: row.supplier ?? '',
      moduleID: row.module_id == null ? null : asSafeInteger(row.module_id, 'stored audit module id'),
      month: row.month ?? '',
      from: row.amount_from == null ? '' : asFiniteNumber(row.amount_from, 'stored audit from amount'),
      to: row.amount_to == null ? '' : asFiniteNumber(row.amount_to, 'stored audit to amount'),
    };
    if (row.projectworks_user_id != null) entry.projectworksUserID = row.projectworks_user_id;
    if (row.synced != null) entry.synced = row.synced;
    if (row.target != null) entry.target = row.target;
    if (row.error != null) entry.error = row.error;
    return entry;
  }

  const auditSelect = `
    SELECT id, time, user_name, projectworks_user_id, action, project, stage,
           supplier, module_id, month, amount_from, amount_to, synced, target,
           error, extra
    FROM audit_log
    WHERE instance_id = $1`;

  async function getSupplierLines(moduleID) {
    return querySupplierLines(pool, moduleID);
  }

  async function getAudit(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('audit limit must be a positive integer');
    const result = await pool.query(
      `${auditSelect} ORDER BY time DESC, id DESC LIMIT $2`,
      [config.instanceId, limit]
    );
    return result.rows.map(rowToAudit);
  }

  async function createSupplierLine(client, input) {
    const moduleID = asSafeInteger(input.moduleID, 'moduleID');
    const supplier = String(input.supplier || '').trim();
    if (!supplier) throw new Error('supplier is required');
    const result = await client.query(
      `INSERT INTO supplier_lines (module_id, supplier, description, instance_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, module_id, supplier, description`,
      [moduleID, supplier, input.description ? String(input.description) : '', config.instanceId]
    );
    const row = result.rows[0];
    return {
      id: asSafeInteger(row.id, 'supplier line id'),
      moduleID: asSafeInteger(row.module_id, 'supplier line module id'),
      supplier: row.supplier,
      description: row.description,
      months: {},
    };
  }

  async function setSupplierLineMonth(client, idValue, month, amountValue) {
    const id = asSafeInteger(idValue, 'supplier line id');
    const amount = asFiniteNumber(amountValue, 'supplier line amount');
    if (!MONTH_PATTERN.test(month)) throw new Error('supplier line month must be YYYY-MM');
    const lineResult = await client.query(
      `SELECT id, module_id, supplier, description
       FROM supplier_lines
       WHERE id = $1 AND instance_id = $2
       FOR UPDATE`,
      [id, config.instanceId]
    );
    if (!lineResult.rowCount) return null;
    const line = lineResult.rows[0];
    const oldResult = await client.query(
      'SELECT amount FROM supplier_line_months WHERE line_id = $1 AND month = $2',
      [id, month]
    );
    const from = oldResult.rowCount ? asFiniteNumber(oldResult.rows[0].amount, 'supplier month amount') : '';
    await client.query(
      `INSERT INTO supplier_line_months (line_id, month, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (line_id, month) DO UPDATE SET amount = EXCLUDED.amount`,
      [id, month, amount]
    );
    await client.query('UPDATE supplier_lines SET updated_at = now() WHERE id = $1', [id]);
    const totalResult = await client.query(
      `SELECT COALESCE(SUM(month.amount), 0) AS total
       FROM supplier_lines AS other_line
       JOIN supplier_line_months AS month ON month.line_id = other_line.id
       WHERE other_line.instance_id = $1
         AND other_line.module_id = $2
         AND month.month = $3`,
      [config.instanceId, line.module_id, month]
    );
    return {
      line: {
        id: asSafeInteger(line.id, 'supplier line id'),
        moduleID: asSafeInteger(line.module_id, 'supplier line module id'),
        supplier: line.supplier,
        description: line.description,
      },
      from,
      moduleTotal: asFiniteNumber(totalResult.rows[0].total, 'module month total'),
    };
  }

  async function deleteSupplierLine(client, idValue) {
    const id = asSafeInteger(idValue, 'supplier line id');
    const result = await client.query(
      `DELETE FROM supplier_lines
       WHERE id = $1 AND instance_id = $2
       RETURNING id, module_id, supplier, description`,
      [id, config.instanceId]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      id: asSafeInteger(row.id, 'supplier line id'),
      moduleID: asSafeInteger(row.module_id, 'supplier line module id'),
      supplier: row.supplier,
      description: row.description,
    };
  }

  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work({
        createSupplierLine: (input) => createSupplierLine(client, input),
        setSupplierLineMonth: (id, month, amount) => setSupplierLineMonth(client, id, month, amount),
        deleteSupplierLine: (id) => deleteSupplierLine(client, id),
        appendAudit: (entry) => insertAudit(client, entry),
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function migrationTotals(queryable) {
    const result = await queryable.query(
      `SELECT
         (SELECT COUNT(*) FROM supplier_lines WHERE instance_id = $1)::text AS lines,
         (SELECT COUNT(*)
            FROM supplier_line_months AS month
            JOIN supplier_lines AS line ON line.id = month.line_id
           WHERE line.instance_id = $1)::text AS months,
         (SELECT COUNT(*) FROM audit_log WHERE instance_id = $1)::text AS audit`,
      [config.instanceId]
    );
    return {
      supplierLines: Number(result.rows[0].lines),
      monthRows: Number(result.rows[0].months),
      auditEntries: Number(result.rows[0].audit),
    };
  }

  async function migrateJsonStore(raw, options = {}) {
    const source = inspectJsonStore(raw);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ensureSchema(client);
      await client.query(
        'LOCK TABLE supplier_lines, supplier_line_months, audit_log IN SHARE ROW EXCLUSIVE MODE'
      );
      const before = await migrationTotals(client);
      if (before.supplierLines || before.monthRows || before.auditEntries) {
        throw new Error(
          `refusing to migrate into non-empty instance ${JSON.stringify(config.instanceId)} ` +
          `(${before.supplierLines} supplier lines, ${before.monthRows} month rows, ${before.auditEntries} audit entries)`
        );
      }

      const importedAt = new Date().toISOString();
      for (const line of raw.supplierLines) {
        await client.query(
          `INSERT INTO supplier_lines
             (id, module_id, supplier, description, instance_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [line.id, line.moduleID, line.supplier, line.description, config.instanceId, importedAt]
        );
        for (const [month, amount] of Object.entries(line.months)) {
          await client.query(
            'INSERT INTO supplier_line_months (line_id, month, amount) VALUES ($1, $2, $3)',
            [line.id, month, amount]
          );
        }
      }
      for (const entry of raw.audit) await insertAudit(client, entry, entry.time);
      await resetSupplierLineSequence(client, nextLineIDFromJsonStore(raw));

      const databaseTotals = await migrationTotals(client);
      if (
        databaseTotals.supplierLines !== source.supplierLines ||
        databaseTotals.monthRows !== source.monthRows ||
        databaseTotals.auditEntries !== source.auditEntries
      ) {
        throw new Error(
          `migration count mismatch: source=${JSON.stringify(source)} database=${JSON.stringify(databaseTotals)}`
        );
      }

      if (options.dryRun) await client.query('ROLLBACK');
      else await client.query('COMMIT');
      return { dryRun: !!options.dryRun, source, databaseTotals };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function nextSupplierLineID(queryable) {
    const result = await queryable.query(
      `SELECT last_value, is_called
       FROM supplier_lines_id_seq`
    );
    const lastValue = asSafeInteger(result.rows[0].last_value, 'supplier line sequence');
    return result.rows[0].is_called ? lastValue + 1 : lastValue;
  }

  async function exportJsonStore() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const supplierLines = await querySupplierLines(client);
      const auditResult = await client.query(`${auditSelect} ORDER BY time ASC, id ASC`, [config.instanceId]);
      const output = {
        initialisedAt: new Date().toISOString(),
        nextLineID: await nextSupplierLineID(client),
        supplierLines,
        audit: auditResult.rows.map(rowToAudit),
      };
      await client.query('COMMIT');
      return output;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    initialize,
    getSupplierLines,
    getAudit,
    transaction,
    trimAuditLog,
    migrateJsonStore,
    exportJsonStore,
    close: () => pool.end(),
  };
}

module.exports = {
  createStorage,
  inspectJsonStore,
  readStorageConfig,
  requireStorageConfig,
};
