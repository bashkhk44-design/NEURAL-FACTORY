'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatformWebhookServer, validatePlatformWebhookEnvironment } = require('../platform-webhook');

const secrets = {
  master: 'M'.repeat(43),
  intake: 'I'.repeat(43)
};

async function withServer(server, callback) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await callback('http://127.0.0.1:' + address.port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('platform webhook environment requires independent URL-safe secrets', () => {
  assert.equal(validatePlatformWebhookEnvironment({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    MASTER_WEBHOOK_SECRET: secrets.master,
    INTAKE_WEBHOOK_SECRET: secrets.intake
  }), true);
  assert.throws(() => validatePlatformWebhookEnvironment({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    MASTER_WEBHOOK_SECRET: 'short',
    INTAKE_WEBHOOK_SECRET: secrets.intake
  }), /MASTER_WEBHOOK_SECRET/);
  assert.throws(() => validatePlatformWebhookEnvironment({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    MASTER_WEBHOOK_SECRET: secrets.master,
    INTAKE_WEBHOOK_SECRET: secrets.master
  }), /must be different/);
});

test('platform webhook authenticates identity and enqueues the exact update', async () => {
  const calls = [];
  const pool = { query: async (_sql, params) => {
    calls.push(params);
    return { rows: [{ id: 7, job_id: 9, state: 'queued', inserted: true, job_inserted: true }], rowCount: 1 };
  } };
  const server = createPlatformWebhookServer({
    pool,
    resolveSecret: identity => secrets[identity],
    logger: { error() {} }
  });

  await withServer(server, async base => {
    const response = await fetch(base + '/telegram/platform/master', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': secrets.master
      },
      body: JSON.stringify({ update_id: 123, message: { text: '/start' } })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, duplicate: false, queued: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'master');
    assert.equal(calls[0][1], 123);
  });
});

test('platform webhook rejects wrong secrets and unknown identities', async () => {
  const pool = { query: async () => { throw new Error('must not enqueue'); } };
  const server = createPlatformWebhookServer({
    pool,
    resolveSecret: identity => secrets[identity],
    logger: { error() {} }
  });

  await withServer(server, async base => {
    const unauthorized = await fetch(base + '/telegram/platform/intake', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': secrets.master
      },
      body: JSON.stringify({ update_id: 124 })
    });
    assert.equal(unauthorized.status, 401);

    const missing = await fetch(base + '/telegram/platform/customer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 125 })
    });
    assert.equal(missing.status, 404);
  });
});


test('platform webhook rejects encoded request bodies before parsing or enqueueing', async () => {
  let enqueueCalls = 0;
  const server = createPlatformWebhookServer({
    pool: { query: async () => { enqueueCalls += 1; throw new Error('must not enqueue'); } },
    resolveSecret: identity => secrets[identity],
    logger: { error() {} }
  });

  await withServer(server, async base => {
    const response = await fetch(base + '/telegram/platform/master', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-telegram-bot-api-secret-token': secrets.master
      },
      body: JSON.stringify({ update_id: 126 })
    });
    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'unsupported_content_encoding'
    });
    assert.equal(enqueueCalls, 0);
  });
});
