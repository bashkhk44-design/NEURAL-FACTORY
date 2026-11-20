const { Pool } = require('pg');
const crypto = require('crypto');
const { getPostgresSslConfig } = require('./postgres-ssl');

const databaseConfig = require('./database-config');
const databaseUrl = databaseConfig.getDatabaseUrl(process.env);

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: getPostgresSslConfig(),
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const lockPool = new Pool({
  connectionString: databaseConfig.getDirectDatabaseUrl(process.env),
  ssl: getPostgresSslConfig(),
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('POSTGRES IDLE CLIENT ERROR:', err.message);
});

lockPool.on('error', (err) => {
  console.error('POSTGRES LOCK POOL ERROR:', err.message);
});

function getEncryptionKey() {
  const value = process.env.BOTS_ENCRYPTION_KEY || '';

  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('BOTS_ENCRYPTION_KEY غير مضبوط بشكل صحيح في Render');
  }

  return Buffer.from(value, 'hex');
}

function encryptToken(token) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(token, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    fingerprint: crypto
      .createHmac('sha256', key)
      .update(token)
      .digest('hex')
  };
}

function decryptToken(record) {
  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.token_iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(record.token_auth_tag, 'hex'));

  let decrypted = decipher.update(
    record.token_ciphertext,
    'base64',
    'utf8'
  );

  decrypted += decipher.final('utf8');
  return decrypted;
}


function encryptSecret(value) {
  if (typeof value !== 'string' || !value.length) {
    throw new Error('قيمة السر يجب أن تكون نصاً غير فارغ.');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final()
  ]).toString('base64');

  return {
    ciphertext,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex')
  };
}

function decryptSecret(record) {
  if (
    !record ||
    !record.secret_ciphertext ||
    !record.secret_iv ||
    !record.secret_auth_tag
  ) {
    throw new Error('بيانات السر المشفر غير مكتملة.');
  }

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.secret_iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(record.secret_auth_tag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(record.secret_ciphertext, 'base64'),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_bots (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE telegram_bots
    ADD COLUMN IF NOT EXISTS token_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS token_iv TEXT,
    ADD COLUMN IF NOT EXISTS token_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS token_fingerprint TEXT
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    telegram_bots_token_fingerprint_idx
    ON telegram_bots(token_fingerprint)
    WHERE token_fingerprint IS NOT NULL
  `);

  console.log('Neon PostgreSQL connected; telegram_bots table ready');

  const { initProjectDatabase } = require('./project-db');
  await initProjectDatabase();
}

async function verifyDatabaseSchema() {
  const requiredTables = [
    'telegram_bots',
    'clients',
    'client_projects',
    'client_conversations',
    'project_specs',
    'project_events',
    'client_intake_sessions',
    'project_secrets',
    'project_ai_jobs',
    'project_ai_job_attempts',
    'project_build_approvals',
    'project_release_candidates',
    'project_release_approvals',
    'project_deployment_authorizations'
  ];

  const result = await pool.query(
    `SELECT table_name,
            to_regclass('public.' || table_name) IS NOT NULL AS exists
     FROM unnest($1::text[]) AS required(table_name)`,
    [requiredTables]
  );

  const missing = result.rows
    .filter((row) => !row.exists)
    .map((row) => row.table_name);

  if (missing.length) {
    throw new Error(
      'قاعدة البيانات غير مهيأة. شغّل Neon Staging Bootstrap بصلاحية المالك. الجداول الناقصة: ' +
      missing.join(', ')
    );
  }

  return true;
}

async function insertTelegramBot({ name, username, token }) {
  const encrypted = encryptToken(token);

  const result = await pool.query(
    `INSERT INTO telegram_bots
      (name, username, active, token_ciphertext,
       token_iv, token_auth_tag, token_fingerprint)
     VALUES ($1, $2, TRUE, $3, $4, $5, $6)
     RETURNING id, name, username, active, created_at`,
    [
      name,
      username,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      encrypted.fingerprint
    ]
  );

  return result.rows[0];
}


async function getActiveTelegramBots() {
  const result = await pool.query(`
    SELECT id, name, username, token_ciphertext,
           token_iv, token_auth_tag
    FROM telegram_bots
    WHERE active = TRUE
      AND token_ciphertext IS NOT NULL
    ORDER BY id ASC
  `);

  return result.rows.map(record => ({
    ...record,
    token: decryptToken(record)
  }));
}


let runtimeLockClient = null;
let runtimeLockFailureHandler = null;
let runtimeLockFailureClient = null;
let runtimeLockFailureError = null;
let lockPoolEndPromise = null;

function setRuntimeLockFailureHandler(handler) {
  if (handler !== null && typeof handler !== 'function') {
    throw new TypeError('Runtime lock failure handler must be a function or null');
  }
  runtimeLockFailureHandler = handler;
}

function notifyRuntimeLockFailure(client, err) {
  if (runtimeLockClient !== client || runtimeLockFailureClient === client) return;

  runtimeLockFailureClient = client;
  runtimeLockClient = null;
  const error = err instanceof Error
    ? err
    : new Error(String(err || 'Telegram runtime lock connection lost'));
  runtimeLockFailureError = error;

  console.error('TELEGRAM RUNTIME LOCK FAILURE:', error.message);

  try {
    client.release(error);
  } catch (_) {}

  if (runtimeLockFailureHandler) {
    Promise.resolve()
      .then(() => runtimeLockFailureHandler(error))
      .catch(handlerError => {
        console.error('RUNTIME LOCK FAILURE HANDLER ERROR:', handlerError.message);
      });
  }
}

function closeLockPool() {
  if (!lockPoolEndPromise) {
    lockPoolEndPromise = lockPool.end();
  }
  return lockPoolEndPromise;
}

async function acquireTelegramRuntimeLock() {
  if (runtimeLockClient) {
    const stillHeld = await isTelegramRuntimeLockHeld();
    if (stillHeld) return true;

    const staleClient = runtimeLockClient;
    if (staleClient) {
      runtimeLockClient = null;
      try {
        staleClient.release();
      } catch (_) {}
    }
  }

  const client = await lockPool.connect();

  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [20261115, 1]
    );

    if (!result.rows[0].locked) {
      client.release();
      return false;
    }

    runtimeLockClient = client;
    runtimeLockFailureClient = null;
    runtimeLockFailureError = null;

    client.on('error', (err) => {
      notifyRuntimeLockFailure(client, err);
    });

    client.on('end', () => {
      notifyRuntimeLockFailure(
        client,
        new Error('Telegram runtime lock connection ended')
      );
    });

    console.log('Telegram runtime lock acquired using direct connection');
    return true;
  } catch (err) {
    client.release(err);
    throw err;
  }
}

async function isTelegramRuntimeLockHeld() {
  const client = runtimeLockClient;

  if (!client || runtimeLockFailureClient === client) {
    return false;
  }

  try {
    const result = await client.query(
      `SELECT EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = pg_backend_pid()
          AND classid = 20261115::oid
          AND objid = 1::oid
          AND objsubid = 2
      ) AS locked`
    );

    return runtimeLockClient === client
      && runtimeLockFailureClient !== client
      && result.rows[0]?.locked === true;
  } catch (err) {
    notifyRuntimeLockFailure(client, err);
    return false;
  }
}

async function releaseTelegramRuntimeLock() {
  const client = runtimeLockClient;
  runtimeLockClient = null;

  let releaseError = runtimeLockFailureError;

  try {
    if (client && !releaseError) {
      await client.query(
        'SELECT pg_advisory_unlock($1, $2)',
        [20261115, 1]
      );
      console.log('Telegram runtime lock released');
    }
  } catch (err) {
    releaseError = err;
    console.error('RUNTIME LOCK UNLOCK ERROR:', err.message);
  } finally {
    if (client) {
      try {
        client.release(releaseError || undefined);
      } catch (err) {
        console.error('RUNTIME LOCK CLIENT RELEASE ERROR:', err.message);
      }
    }

    await closeLockPool();
  }
}

module.exports = {
  pool,
  initDatabase,
  verifyDatabaseSchema,
  insertTelegramBot,
  getActiveTelegramBots,
  decryptToken,
  encryptSecret,
  decryptSecret,
  acquireTelegramRuntimeLock,
  isTelegramRuntimeLockHeld,
  releaseTelegramRuntimeLock,
  setRuntimeLockFailureHandler
};
