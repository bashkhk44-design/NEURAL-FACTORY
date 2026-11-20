'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

const LOCK_KEY_1 = 20261117;
const LOCK_KEY_2 = 1;

function listMigrationFiles(directory, fsApi = fs) {
  return fsApi.readdirSync(directory)
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function extractMigrationBody(sql, filename) {
  const start = sql.match(/^\s*(?:--[^\r\n]*(?:\r?\n|$)\s*)*BEGIN\s*;/i);
  const end = /\bCOMMIT\s*;\s*$/i;

  if (!start || !end.test(sql)) {
    throw new Error(
      `Migration ${filename} must contain a transaction beginning with BEGIN and ending with COMMIT`
    );
  }

  const body = sql.slice(start[0].length).replace(end, '').trim();

  if (!body) {
    throw new Error(`Migration ${filename} has an empty body`);
  }

  return body;
}

function createMigrationRunner({
  pool,
  migrationsDir = __dirname,
  fsApi = fs,
  logger = console
}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required');
  }

  return {
    async run() {
      const client = await pool.connect();
      let lockAcquired = false;
      const applied = [];
      const skipped = [];

      try {
        const lock = await client.query(
          'SELECT pg_try_advisory_lock($1, $2) AS locked',
          [LOCK_KEY_1, LOCK_KEY_2]
        );

        lockAcquired = lock.rows[0]?.locked === true;

        if (!lockAcquired) {
          throw new Error('Another migration runner is already active');
        }

        await client.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        for (const filename of listMigrationFiles(migrationsDir, fsApi)) {
          const version = filename.replace(/\.sql$/i, '');

          const existing = await client.query(
            'SELECT version FROM schema_migrations WHERE version = $1',
            [version]
          );

          if (existing.rowCount > 0) {
            skipped.push(version);
            continue;
          }

          const sql = fsApi.readFileSync(
            path.join(migrationsDir, filename),
            'utf8'
          );
          const body = extractMigrationBody(sql, filename);

          try {
            await client.query('BEGIN');
            await client.query(body);

            await client.query(
              `INSERT INTO schema_migrations(version, description)
               VALUES ($1, $2)`,
              [version, `Applied migration file ${filename}`]
            );

            await client.query('COMMIT');

            applied.push(version);
            logger.log(`Migration applied: ${version}`);
          } catch (error) {
            try {
              await client.query('ROLLBACK');
            } catch (_) {}

            throw new Error(
              `Migration ${version} failed: ${error.message}`,
              { cause: error }
            );
          }
        }

        return { applied, skipped };
      } finally {
        if (lockAcquired) {
          try {
            await client.query(
              'SELECT pg_advisory_unlock($1, $2)',
              [LOCK_KEY_1, LOCK_KEY_2]
            );
          } catch (error) {
            logger.error(
              'Could not release migration advisory lock:',
              error.message
            );
          }
        }

        client.release();
      }
    }
  };
}


function parseDatabaseTarget(value, name) {
  if (!value) throw new Error(name + ' is required. Refusing migration.');

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(name + ' is invalid. Refusing migration.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(name + ' must use PostgreSQL. Refusing migration.');
  }

  return {
    host: url.hostname.toLowerCase(),
    database: url.pathname.replace(/^\//, ''),
    username: decodeURIComponent(url.username)
  };
}

function validateMigrationTargets(env = process.env) {
  const app = parseDatabaseTarget(
    env.STAGING_DATABASE_URL,
    'STAGING_DATABASE_URL'
  );
  const owner = parseDatabaseTarget(
    env.STAGING_OWNER_DATABASE_URL,
    'STAGING_OWNER_DATABASE_URL'
  );
  const production = parseDatabaseTarget(
    env.DATABASE_URL,
    'DATABASE_URL'
  );

  if (app.host !== owner.host || app.database !== owner.database) {
    throw new Error('Staging application and owner connections must target the same endpoint and database.');
  }

  if (owner.username !== 'neondb_owner') {
    throw new Error('Staging migration connection must use neondb_owner.');
  }

  if (app.host === production.host && app.database === production.database) {
    throw new Error('Staging target matches DATABASE_URL. Refusing migration.');
  }

  return { stagingOwnerUrl: env.STAGING_OWNER_DATABASE_URL };
}

async function main() {
  const { stagingOwnerUrl } = validateMigrationTargets(process.env);
  const connectionString = stagingOwnerUrl;

  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'disable'
      ? false
      : { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });

  try {
    if (stagingOwnerUrl) {
      const identity = await pool.query(
        'SELECT current_database() AS db, current_user AS role'
      );
      const target = identity.rows[0];

      if (target.db !== 'neondb' || target.role !== 'neondb_owner') {
        throw new Error('Refusing migration: expected neondb and neondb_owner.');
      }

      console.log('Verified staging database and owner role.');
    }

    const runner = createMigrationRunner({ pool });
    const result = await runner.run();
    console.log('Database migrations complete:', JSON.stringify(result));
  } finally {
    await pool.end();
  }
}
if (require.main === module) {
  main().catch((error) => {
    console.error('DATABASE MIGRATION FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createMigrationRunner,
  listMigrationFiles,
  extractMigrationBody,
  validateMigrationTargets
};
