import { Client } from 'pg';
import platformQueue from '../platform-queue.js';

const { enqueuePlatformBotUpdate } = platformQueue;
const MAX_BODY_BYTES = 1024 * 1024;
const DB_CONNECT_TIMEOUT_MS = 5000;
const DB_QUERY_TIMEOUT_MS = 10000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function resolvePlatformSecret(identity, env) {
  if (env.PLATFORM_BOT_WEBHOOK_MODE !== 'enabled') return null;

  const master = env.MASTER_WEBHOOK_SECRET;
  const intake = env.INTAKE_WEBHOOK_SECRET;
  if (!SECRET_PATTERN.test(master || '') || !SECRET_PATTERN.test(intake || '') ||
      master === intake) {
    return null;
  }

  const webhookSecrets = [master, intake];
  const botTokens = [env.TELEGRAM_BOT_TOKEN, env.INTAKE_BOT_TOKEN]
    .filter(token => typeof token === 'string' && token.length > 0);
  if (webhookSecrets.some(secret => botTokens.includes(secret))) {
    return null;
  }

  return identity === 'master' ? master : intake;
}

async function readRequestBody(request, maxBodyBytes) {
  const reader = request.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), tooLarge: false };

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        return { bytes: null, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, tooLarge: false };
}

export function createPlatformWebhookHandler({
  ClientClass = Client,
  enqueue = enqueuePlatformBotUpdate,
  maxBodyBytes = MAX_BODY_BYTES
} = {}) {
  if (typeof ClientClass !== 'function') throw new TypeError('PostgreSQL Client class is required');
  if (typeof enqueue !== 'function') throw new TypeError('Platform update enqueue function is required');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) {
    throw new RangeError('maxBodyBytes must be at least 1024');
  }

  return async function fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') {
      const connectionString = env.HYPERDRIVE?.connectionString;
      if (typeof connectionString !== 'string' || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
        return jsonResponse(503, { ok: false, error: 'database_unavailable' });
      }

      let healthClient;
      try {
        healthClient = new ClientClass({
          connectionString,
          connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
          query_timeout: DB_QUERY_TIMEOUT_MS,
          statement_timeout: DB_QUERY_TIMEOUT_MS
        });
        await healthClient.connect();
        const result = await healthClient.query('SELECT 1 AS probe');
        if (result.rows?.[0]?.probe !== 1) {
          return jsonResponse(503, { ok: false, error: 'database_unavailable' });
        }
        return jsonResponse(200, { ok: true, service: 'platform-telegram-webhook-edge', database: 'reachable' });
      } catch (_) {
        return jsonResponse(503, { ok: false, error: 'database_unavailable' });
      } finally {
        if (healthClient) {
          try { await healthClient.end(); } catch (_) {}
        }
      }
    }

    const match = url.pathname.match(/^\/telegram\/platform\/(master|intake)$/);
    if (!match || env.PLATFORM_BOT_WEBHOOK_MODE !== 'enabled') {
      return jsonResponse(404, { ok: false, error: 'not_found' });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
        status: 405,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          allow: 'POST'
        }
      });
    }

    const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      return jsonResponse(415, { ok: false, error: 'unsupported_media_type' });
    }

    const contentEncoding = (request.headers.get('content-encoding') || 'identity').trim().toLowerCase();
    if (contentEncoding !== 'identity') {
      await request.body?.cancel().catch(() => {});
      return jsonResponse(415, { ok: false, error: 'unsupported_content_encoding' });
    }

    const declaredLength = request.headers.get('content-length');
    if (declaredLength !== null) {
      if (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
        return jsonResponse(400, { ok: false, error: 'invalid_content_length' });
      }
      if (Number(declaredLength) > maxBodyBytes) {
        await request.body?.cancel();
        return jsonResponse(413, { ok: false, error: 'payload_too_large' });
      }
    }

    const identity = match[1];
    const expectedSecret = resolvePlatformSecret(identity, env);
    const suppliedSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (!expectedSecret || !safeEqual(suppliedSecret, expectedSecret)) {
      await request.body?.cancel();
      return jsonResponse(401, { ok: false, error: 'unauthorized' });
    }

    const body = await readRequestBody(request, maxBodyBytes);
    if (body.tooLarge) {
      return jsonResponse(413, { ok: false, error: 'payload_too_large' });
    }

    let update;
    try {
      update = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch (_) {
      return jsonResponse(400, { ok: false, error: 'invalid_json' });
    }

    if (!update || typeof update !== 'object' || Array.isArray(update) ||
        !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      return jsonResponse(400, { ok: false, error: 'invalid_update' });
    }

    const connectionString = env.HYPERDRIVE?.connectionString;
    if (typeof connectionString !== 'string' || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      return jsonResponse(503, { ok: false, error: 'temporarily_unavailable' });
    }

    let client;
    try {
      client = new ClientClass({
        connectionString,
        connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
        query_timeout: DB_QUERY_TIMEOUT_MS,
        statement_timeout: DB_QUERY_TIMEOUT_MS
      });
      await client.connect();
      const queued = await enqueue(client, { botIdentity: identity, update });
      return jsonResponse(200, {
        ok: true,
        duplicate: queued.duplicate,
        queued: !queued.duplicate
      });
    } catch (error) {
      console.error('PLATFORM TELEGRAM WEBHOOK ERROR:', error?.message || 'unknown');
      return jsonResponse(503, { ok: false, error: 'temporarily_unavailable' });
    } finally {
      if (client) {
        try { await client.end(); } catch (_) {}
      }
    }
  };
}

export default {
  fetch: createPlatformWebhookHandler()
};
