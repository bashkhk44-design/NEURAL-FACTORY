'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const { deriveTelegramWebhookSecret } = require('./telegram-webhook-secret');
const { createTelegramWebhookServer } = require('./telegram-webhook-server');

function getWebhookSslConfig(env = process.env) {
  return env.DATABASE_SSL === 'disable' ? false : true;
}

function createCustomerWebhookSecretResolver({ pool, decryptToken, encryptionKey }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (typeof decryptToken !== 'function') throw new TypeError('decryptToken(record) is required');

  return async botId => {
    const result = await pool.query(
      'SELECT id, token_ciphertext, token_iv, token_auth_tag ' +
      'FROM telegram_bots WHERE id = $1 AND active = TRUE ' +
      "AND update_transport = 'webhook' AND token_ciphertext IS NOT NULL LIMIT 1",
      [botId]
    );
    if (!result.rowCount) return null;
    const token = decryptToken(result.rows[0]);
    return deriveTelegramWebhookSecret(botId, token, encryptionKey);
  };
}

function validatePlatformWebhookSecrets(env = {}) {
  const mode = env.PLATFORM_BOT_WEBHOOK_MODE;
  if (mode === undefined || mode === 'disabled') return true;
  if (mode !== 'enabled') {
    throw new Error('PLATFORM_BOT_WEBHOOK_MODE must be enabled or disabled');
  }

  const secretPattern = /^[A-Za-z0-9_-]{32,256}$/;
  for (const name of ['MASTER_WEBHOOK_SECRET', 'INTAKE_WEBHOOK_SECRET']) {
    if (!secretPattern.test(env[name] || '')) {
      throw new Error(name + ' must be 32-256 URL-safe characters when platform webhooks are enabled');
    }
  }
  if (env.MASTER_WEBHOOK_SECRET === env.INTAKE_WEBHOOK_SECRET) {
    throw new Error('Master and intake webhook secrets must be different');
  }
  if (env.TELEGRAM_BOT_TOKEN && env.MASTER_WEBHOOK_SECRET === env.TELEGRAM_BOT_TOKEN) {
    throw new Error('Master webhook secret must be independent from the Telegram bot token');
  }
  if (env.INTAKE_BOT_TOKEN && env.INTAKE_WEBHOOK_SECRET === env.INTAKE_BOT_TOKEN) {
    throw new Error('Intake webhook secret must be independent from the Telegram bot token');
  }
  return true;
}

function validateWebhookEnvironment(env = process.env) {
  const databaseUrl = require('./database-config').getDatabaseUrl(env);
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('Database URL must use the PostgreSQL protocol');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(env.BOTS_ENCRYPTION_KEY || '')) {
    throw new Error('BOTS_ENCRYPTION_KEY must be a 32-byte hex key');
  }
  if (env.DATABASE_SSL !== undefined && !['require', 'disable'].includes(env.DATABASE_SSL)) {
    throw new Error('DATABASE_SSL must be either require or disable');
  }
  validatePlatformWebhookSecrets(env);
  return true;
}

async function main() {
  validateWebhookEnvironment();

  const { decryptToken } = require('./db');
  const pool = new Pool({
    connectionString: require('./database-config').getDatabaseUrl(process.env),
    ssl: getWebhookSslConfig(),
    max: Number(process.env.WEBHOOK_DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  const encryptionKey = Buffer.from(process.env.BOTS_ENCRYPTION_KEY, 'hex');
  const server = createTelegramWebhookServer({
    pool,
    resolveSecret: createCustomerWebhookSecretResolver({
      pool,
      decryptToken,
      encryptionKey
    }),
    resolvePlatformSecret: process.env.PLATFORM_BOT_WEBHOOK_MODE === 'enabled'
      ? async identity => identity === 'master'
        ? process.env.MASTER_WEBHOOK_SECRET
        : process.env.INTAKE_WEBHOOK_SECRET
      : undefined
  });

  const port = Number(process.env.PORT || 8081);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  console.log('BOSS Telegram webhook ingress listening on port ' + port);

  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    console.log('Webhook ingress stopping: ' + signal);
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
    console.error('Webhook shutdown failed:', error.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
    console.error('Webhook shutdown failed:', error.message);
    process.exitCode = 1;
  }));
}

if (require.main === module) {
  main().catch(error => {
    console.error('WEBHOOK INGRESS STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, validateWebhookEnvironment, getWebhookSslConfig, validatePlatformWebhookSecrets, createCustomerWebhookSecretResolver };
