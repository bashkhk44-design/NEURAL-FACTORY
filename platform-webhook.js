'use strict';

require('dotenv').config();

const http = require('node:http');
const crypto = require('node:crypto');
const { enqueuePlatformBotUpdate } = require('./platform-queue');

const IDENTITIES = Object.freeze(['master', 'intake']);

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validatePlatformWebhookEnvironment(env = process.env) {
  require('./database-config').getDatabaseUrl(env);
  // Telegram webhook secrets are authentication credentials, not bot API tokens.
  // Reject reuse against either platform token to keep the transport boundary separate.
  const webhookSecrets = [
    ['MASTER_WEBHOOK_SECRET', env.MASTER_WEBHOOK_SECRET],
    ['INTAKE_WEBHOOK_SECRET', env.INTAKE_WEBHOOK_SECRET]
  ];
  const botTokens = [
    ['TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN],
    ['INTAKE_BOT_TOKEN', env.INTAKE_BOT_TOKEN]
  ];
  for (const [secretName, secretValue] of webhookSecrets) {
    for (const [tokenName, tokenValue] of botTokens) {
      if (typeof tokenValue === 'string' && tokenValue.length > 0 && secretValue === tokenValue) {
        throw new Error(secretName + ' must be independent from ' + tokenName);
      }
    }
  }
  for (const name of ['MASTER_WEBHOOK_SECRET', 'INTAKE_WEBHOOK_SECRET']) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(env[name] || '')) {
      throw new Error(name + ' must be 32-256 URL-safe characters');
    }
  }
  if (env.MASTER_WEBHOOK_SECRET === env.INTAKE_WEBHOOK_SECRET) {
    throw new Error('Master and intake webhook secrets must be different');
  }

  return true;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function createPlatformWebhookServer({
  pool,
  resolveSecret,
  maxBodyBytes = 1024 * 1024,
  logger = console
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (typeof resolveSecret !== 'function') throw new TypeError('resolveSecret(identity) is required');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new RangeError('maxBodyBytes must be at least 1024');

  const server = http.createServer(async (req, res) => {
    const match = String(req.url || '').split('?')[0].match(/^\/telegram\/platform\/(master|intake)$/);
    if (!match) return sendJson(res, 404, { ok: false, error: 'not_found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    const identity = match[1];
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') return sendJson(res, 415, { ok: false, error: 'unsupported_media_type' });

    const contentEncoding = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
    if (contentEncoding !== 'identity') {
      req.resume();
      return sendJson(res, 415, { ok: false, error: 'unsupported_content_encoding' });
    }

    const declaredLength = req.headers['content-length'];
    if (declaredLength !== undefined) {
      const length = String(declaredLength);
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
        req.resume();
        return sendJson(res, 400, { ok: false, error: 'invalid_content_length' });
      }
      if (Number(length) > maxBodyBytes) {
        req.resume();
        return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      }
    }

    try {
      const expected = await resolveSecret(identity);
      const supplied = req.headers['x-telegram-bot-api-secret-token'];
      if (!expected || !safeEqual(supplied, expected)) {
        req.resume();
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          req.resume();
          return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
        }
        chunks.push(chunk);
      }

      let update;
      try {
        update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {
        return sendJson(res, 400, { ok: false, error: 'invalid_json' });
      }
      if (!update || typeof update !== 'object' || Array.isArray(update) ||
          !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
        return sendJson(res, 400, { ok: false, error: 'invalid_update' });
      }

      const queued = await enqueuePlatformBotUpdate(pool, { botIdentity: identity, update });
      return sendJson(res, 200, {
        ok: true,
        duplicate: queued.duplicate,
        queued: !queued.duplicate
      });
    } catch (error) {
      logger.error('PLATFORM TELEGRAM WEBHOOK INGEST ERROR:', error.message);
      return sendJson(res, 503, { ok: false, error: 'temporarily_unavailable' });
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

async function main() {
  validatePlatformWebhookEnvironment();
  const { pool } = require('./db');
  const server = createPlatformWebhookServer({
    pool,
    resolveSecret: identity => identity === 'master'
      ? process.env.MASTER_WEBHOOK_SECRET
      : identity === 'intake'
        ? process.env.INTAKE_WEBHOOK_SECRET
        : null
  });
  const port = Number(process.env.PORT || 8082);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  console.log('BOSS platform Telegram webhook ingress listening on port ' + port);

  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    console.log('Platform webhook ingress stopping: ' + signal);
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
    console.error('Platform webhook shutdown failed:', error.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
    console.error('Platform webhook shutdown failed:', error.message);
    process.exitCode = 1;
  }));
}

if (require.main === module) {
  main().catch(error => {
    console.error('PLATFORM TELEGRAM WEBHOOK STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  IDENTITIES,
  safeEqual,
  validatePlatformWebhookEnvironment,
  createPlatformWebhookServer,
  main
};
