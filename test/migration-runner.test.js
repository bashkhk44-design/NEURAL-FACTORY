'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createMigrationRunner,
  listMigrationFiles,
  extractMigrationBody,
  validateMigrationTargets
} = require('../migrations/runner');

function makePool({ locked = true, failLedger = false } = {}) {
  const applied = new Set();
  const calls = [];

  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked }], rowCount: 1 };
      }

      if (sql.includes('SELECT version FROM schema_migrations')) {
        const exists = applied.has(params[0]);
        return {
          rows: exists ? [{ version: params[0] }] : [],
          rowCount: exists ? 1 : 0
        };
      }

      if (sql.includes('INSERT INTO schema_migrations')) {
        if (failLedger) throw new Error('Simulated ledger failure');
        applied.add(params[0]);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },

    release() {
      calls.push({ released: true });
    }
  };

  return {
    pool: { async connect() { return client; } },
    applied,
    calls
  };
}

test('migration runner applies pending files once and skips recorded versions', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'boss-migrations-')
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(directory, '001_test_foundation.sql'),
    '-- migration header comment\n-- safe fixture\nBEGIN; SELECT 1; COMMIT;'
  );

  const mock = makePool();
  const runner = createMigrationRunner({
    pool: mock.pool,
    migrationsDir: directory,
    logger: { log() {}, error() {} }
  });

  const first = await runner.run();
  const second = await runner.run();

  assert.deepEqual(first.applied, ['001_test_foundation']);
  assert.deepEqual(second.skipped, ['001_test_foundation']);
  assert.equal(mock.applied.size, 1);

  assert.equal(
    mock.calls.filter((call) => call.sql === 'BEGIN').length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.sql === 'COMMIT').length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.sql === 'ROLLBACK').length,
    0
  );
  assert.equal(
    mock.calls.filter((call) => call.sql && call.sql.includes('SELECT 1;')).length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.released).length,
    2
  );
});

test('migration runner rolls back when ledger registration fails', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'boss-migrations-')
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(directory, '001_test_failure.sql'),
    'BEGIN; SELECT 1; COMMIT;'
  );

  const mock = makePool({ failLedger: true });
  const runner = createMigrationRunner({
    pool: mock.pool,
    migrationsDir: directory,
    logger: { log() {}, error() {} }
  });

  await assert.rejects(runner.run(), /Simulated ledger failure/);

  assert.equal(mock.applied.size, 0);
  assert.equal(
    mock.calls.filter((call) => call.sql === 'BEGIN').length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.sql === 'ROLLBACK').length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.sql === 'COMMIT').length,
    0
  );
  assert.equal(
    mock.calls.filter((call) => call.released).length,
    1
  );
});

test('migration runner refuses to proceed when another runner owns the lock', async () => {
  const mock = makePool({ locked: false });
  const runner = createMigrationRunner({
    pool: mock.pool,
    migrationsDir: os.tmpdir(),
    logger: { log() {}, error() {} }
  });

  await assert.rejects(runner.run(), /already active/);
  assert.equal(mock.calls.filter((call) => call.released).length, 1);
});

test('migration discovery is ordered and ignores non-migration files', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'boss-migration-list-')
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  for (const name of ['002_second.sql', 'notes.txt', '001_first.sql']) {
    fs.writeFileSync(path.join(directory, name), '');
  }

  assert.deepEqual(
    listMigrationFiles(directory),
    ['001_first.sql', '002_second.sql']
  );
});

test('migration SQL wrapper is extracted without nested transaction commands', () => {
  const body = extractMigrationBody(
    '-- header\nBEGIN;\nCREATE TABLE example (id INTEGER);\nCOMMIT;',
    '001_example.sql'
  );

  assert.match(body, /CREATE TABLE example/);
  assert.doesNotMatch(body, /^\s*BEGIN/i);
  assert.doesNotMatch(body, /COMMIT\s*;?\s*$/i);
});

test('foundation migration has balanced PL/pgSQL dollar delimiters and ownership checks', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '001_foundation_database.sql'),
    'utf8'
  );

  assert.equal((sql.match(/DO \$\$/g) || []).length, 3);
  assert.equal((sql.match(/END \$\$;/g) || []).length, 3);
  assert.doesNotMatch(sql, /DO \$(?:\s|\n)/);

  for (const constraint of [
    'telegram_bots_project_requires_client',
    'platform_jobs_project_requires_client',
    'ai_usage_project_requires_client',
    'platform_audit_project_requires_client'
  ]) {
    assert.ok(sql.includes(constraint), `missing ownership constraint: ${constraint}`);
  }
});


const stagingApp = 'postgresql://hyperdrive_user:secret@staging-endpoint.aws.neon.tech/neondb';
const stagingOwner = 'postgresql://neondb_owner:secret@staging-endpoint.aws.neon.tech/neondb';
const production = 'postgresql://hyperdrive_user:secret@production-endpoint.aws.neon.tech/neondb';

test('migration target validation accepts distinct staging and production endpoints', () => {
  const result = validateMigrationTargets({
    STAGING_DATABASE_URL: stagingApp,
    STAGING_OWNER_DATABASE_URL: stagingOwner,
    DATABASE_URL: production
  });
  assert.equal(result.stagingOwnerUrl, stagingOwner);
});

test('migration target validation requires all three database URLs', () => {
  assert.throws(() => validateMigrationTargets({
    STAGING_DATABASE_URL: stagingApp,
    STAGING_OWNER_DATABASE_URL: stagingOwner
  }), /DATABASE_URL is required/);
});

test('migration target validation rejects staging that matches production', () => {
  assert.throws(() => validateMigrationTargets({
    STAGING_DATABASE_URL: stagingApp,
    STAGING_OWNER_DATABASE_URL: stagingOwner,
    DATABASE_URL: stagingApp
  }), /matches DATABASE_URL/);
});

test('migration target validation rejects mismatched staging endpoints', () => {
  assert.throws(() => validateMigrationTargets({
    STAGING_DATABASE_URL: stagingApp,
    STAGING_OWNER_DATABASE_URL: stagingOwner.replace('staging-endpoint', 'other-endpoint'),
    DATABASE_URL: production
  }), /same endpoint and database/);
});

test('migration target validation rejects an unexpected owner role', () => {
  assert.throws(() => validateMigrationTargets({
    STAGING_DATABASE_URL: stagingApp,
    STAGING_OWNER_DATABASE_URL: stagingOwner.replace('neondb_owner', 'hyperdrive_user'),
    DATABASE_URL: production
  }), /must use neondb_owner/);
});
