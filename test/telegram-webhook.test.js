'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTelegramWebhookServer } = require('../telegram-webhook-server');

function request(port, {
  method = 'POST',
  path = '/telegram/webhook/12',
  secret = 'test_secret_123',
  body = '{}',
  contentType = 'application/json'
} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'content-type': contentType,
        'x-telegram-bot-api-secret-token': secret,
        'content-length': Buffer.byteLength(body)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('webhook ingress authenticates Telegram and queues valid updates', async t => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [{ id: 4, job_id: 5, state: 'queued', inserted: true, job_inserted: true }] };
    }
  };
  const server = createTelegramWebhookServer({
    pool,
    resolveSecret: async botId => botId === 12 ? 'test_secret_123' : null,
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const accepted = await request(port, {
    body: JSON.stringify({ update_id: 991, message: { text: '/start' } })
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.queued, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO bot_inbound_updates/);
  assert.match(queries[0].sql, /INSERT INTO platform_jobs/);

  const rejected = await request(port, { secret: 'wrong_secret' });
  assert.equal(rejected.status, 401);
  assert.equal(queries.length, 1);
});

test('webhook ingress rejects invalid JSON and unsupported methods', async t => {
  const server = createTelegramWebhookServer({
    pool: { async query() { assert.fail('invalid request must not reach database'); } },
    resolveSecret: async () => 'test_secret_123',
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const invalid = await request(port, { body: '{bad json' });
  assert.equal(invalid.status, 400);
  const method = await request(port, { method: 'GET' });
  assert.equal(method.status, 405);
});

test('webhook ingress rejects non-integer, negative, and string update identifiers', async t => {
  const queries = [];
  const server = createTelegramWebhookServer({
    pool: { async query(sql, params) { queries.push({ sql, params }); return { rowCount: 1, rows: [{ id: 1, job_id: 2, state: 'queued', inserted: true, job_inserted: true }] }; } },
    resolveSecret: async () => 'test_secret_123',
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  for (const update of [
    { update_id: -1 },
    { update_id: 1.5 },
    { update_id: '123' },
    { update_id: Number.MAX_SAFE_INTEGER + 1 },
    []
  ]) {
    const response = await request(port, { body: JSON.stringify(update) });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_update');
  }
  assert.equal(queries.length, 0);
});

test('webhook ingress rejects oversized request bodies', async t => {
  const server = createTelegramWebhookServer({
    pool: { async query() { assert.fail('oversized request must not reach database'); } },
    resolveSecret: async () => 'test_secret_123',
    maxBodyBytes: 1024,
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await request(server.address().port, {
    body: JSON.stringify({ update_id: 1, text: 'x'.repeat(2048) })
  });
  assert.equal(response.status, 413);
  assert.equal(response.body.error, 'payload_too_large');
});

test('webhook ingress rejects non-JSON content types before database access', async t => {
  const server = createTelegramWebhookServer({
    pool: { async query() { assert.fail('unsupported media type must not reach database'); } },
    resolveSecret: async () => 'test_secret_123',
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await request(server.address().port, { contentType: 'text/plain' });
  assert.equal(response.status, 415);
  assert.equal(response.body.error, 'unsupported_media_type');
});

test('webhook ingress accepts JSON content type parameters', async t => {
  const server = createTelegramWebhookServer({
    pool: { async query() { return { rowCount: 1, rows: [{ id: 1, job_id: 2, state: 'queued', inserted: true, job_inserted: true }] }; } },
    resolveSecret: async () => 'test_secret_123',
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await request(server.address().port, {
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ update_id: 4 })
  });
  assert.equal(response.status, 200);
});

test('webhook server applies bounded header and request timeouts', () => {
  const server = createTelegramWebhookServer({
    pool: { async query() {} },
    resolveSecret: async () => 'test_secret_123',
    headersTimeoutMs: 2000,
    requestTimeoutMs: 5000
  });
  assert.equal(server.headersTimeout, 2000);
  assert.equal(server.requestTimeout, 5000);
  // The server is intentionally not listening in this configuration-only test.
});

test('webhook server rejects invalid timeout configuration', () => {
  assert.throws(() => createTelegramWebhookServer({
    pool: { async query() {} },
    resolveSecret: async () => 'test_secret_123',
    headersTimeoutMs: 5000,
    requestTimeoutMs: 4000
  }), /requestTimeoutMs must be at least headersTimeoutMs/);
});


test('platform webhook routes authenticate master and intake with independent secrets', async t => {
  const queries = [];
  const resolved = [];
  const secrets = {
    master: 'master_webhook_secret_12345678901234567890',
    intake: 'intake_webhook_secret_12345678901234567890'
  };
  const server = createTelegramWebhookServer({
    pool: {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rowCount: 1, rows: [{ id: 44, job_id: 55, state: 'queued', inserted: true, job_inserted: true }] };
      }
    },
    resolveSecret: async () => null,
    resolvePlatformSecret: async identity => {
      resolved.push(identity);
      return secrets[identity] || null;
    },
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const update = JSON.stringify({ update_id: 712, message: { text: '/start' } });

  const wrongSecret = await request(port, {
    path: '/telegram/platform/master',
    secret: secrets.intake,
    body: update
  });
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.body.error, 'unauthorized');
  assert.equal(queries.length, 0);

  const master = await request(port, {
    path: '/telegram/platform/master',
    secret: secrets.master,
    body: update
  });
  assert.equal(master.status, 200);
  assert.equal(master.body.queued, true);
  assert.equal(queries[0].params[0], 'master');
  assert.match(queries[0].sql, /platform_bot_inbound_updates/);

  const intake = await request(port, {
    path: '/telegram/platform/intake',
    secret: secrets.intake,
    body: update
  });
  assert.equal(intake.status, 200);
  assert.equal(queries[1].params[0], 'intake');
  assert.deepEqual(resolved, ['master', 'master', 'intake']);
});

test('platform webhook routes are not exposed without an explicit secret resolver', async t => {
  const server = createTelegramWebhookServer({
    pool: { async query() { assert.fail('unknown platform route must not enqueue'); } },
    resolveSecret: async () => 'customer-secret',
    logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await request(server.address().port, {
    path: '/telegram/platform/master',
    body: JSON.stringify({ update_id: 1 })
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'not_found');
});
