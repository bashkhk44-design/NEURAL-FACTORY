'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { enqueueTelegramUpdate, enqueuePlatformBotUpdate } = require('./platform-queue');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function createTelegramWebhookServer({
  pool,
  resolveSecret,
  resolvePlatformSecret = null,
  maxBodyBytes = 1024 * 1024,
  headersTimeoutMs = 10_000,
  requestTimeoutMs = 30_000,
  logger = console
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (typeof resolveSecret !== 'function') throw new TypeError('resolveSecret(botId) is required');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new RangeError('maxBodyBytes must be at least 1024');
  if (!Number.isInteger(headersTimeoutMs) || headersTimeoutMs < 1000) throw new RangeError('headersTimeoutMs must be at least 1000');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < headersTimeoutMs) {
    throw new RangeError('requestTimeoutMs must be at least headersTimeoutMs');
  }

  const server = http.createServer(async (req, res) => {
    const pathname = (req.url || '').split('?')[0];
    const customerMatch = pathname.match(/^\/telegram\/webhook\/(\d+)$/);
    const platformMatch = pathname.match(/^\/telegram\/platform\/(master|intake)$/);

    if (!customerMatch && (!platformMatch || typeof resolvePlatformSecret !== 'function')) {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    const botId = customerMatch ? Number(customerMatch[1]) : null;
    const botIdentity = platformMatch ? platformMatch[1] : null;
    if (customerMatch && (!Number.isSafeInteger(botId) || botId < 1)) {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }

    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      return sendJson(res, 415, { ok: false, error: 'unsupported_media_type' });
    }

    const declaredLength = req.headers['content-length'];
    if (declaredLength !== undefined) {
      const lengthText = String(declaredLength);
      if (!/^\d+$/.test(lengthText) || !Number.isSafeInteger(Number(lengthText))) {
        return sendJson(res, 400, { ok: false, error: 'invalid_content_length' });
      }
      if (Number(lengthText) > maxBodyBytes) {
        req.resume();
        return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      }
    }

    try {
      const expectedSecret = botIdentity
        ? await resolvePlatformSecret(botIdentity)
        : await resolveSecret(botId);
      const suppliedSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (!expectedSecret || !safeEqual(suppliedSecret, expectedSecret)) {
        req.resume();
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) {
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

      const queued = botIdentity
        ? await enqueuePlatformBotUpdate(pool, { botIdentity, update })
        : await enqueueTelegramUpdate(pool, { botId, update });
      return sendJson(res, 200, {
        ok: true,
        duplicate: queued.duplicate,
        queued: !queued.duplicate
      });
    } catch (error) {
      logger.error('TELEGRAM WEBHOOK INGEST ERROR:', error.message);
      return sendJson(res, 503, { ok: false, error: 'temporarily_unavailable' });
    }
  });

  // Bound slow header delivery and total request-body receipt time.
  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  return server;
}

module.exports = { createTelegramWebhookServer };
