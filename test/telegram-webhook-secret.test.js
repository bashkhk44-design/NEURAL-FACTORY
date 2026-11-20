'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveTelegramWebhookSecret } = require('../telegram-webhook-secret');

test('webhook secret derivation is stable per bot and token without storing a separate secret', () => {
  const key = Buffer.alloc(32, 7);
  const first = deriveTelegramWebhookSecret(12, 'token-value', key);
  assert.equal(first, deriveTelegramWebhookSecret(12, 'token-value', key));
  assert.notEqual(first, deriveTelegramWebhookSecret(13, 'token-value', key));
  assert.notEqual(first, deriveTelegramWebhookSecret(12, 'different-token', key));
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('webhook secret derivation rejects weak key material and invalid bot identifiers', () => {
  assert.throws(() => deriveTelegramWebhookSecret(1, 'token', Buffer.alloc(16)), /32-byte/);
  assert.throws(() => deriveTelegramWebhookSecret(0, 'token', Buffer.alloc(32)), /botId/);
});


test('customer webhook secret resolver only accepts active bots configured for webhook transport', async () => {
  const { createCustomerWebhookSecretResolver } = require('../webhook');
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rowCount: 0, rows: [] };
    }
  };
  const resolveSecret = createCustomerWebhookSecretResolver({
    pool,
    decryptToken: () => 'unused',
    encryptionKey: Buffer.alloc(32, 9)
  });

  assert.equal(await resolveSecret(42), null);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /active = TRUE/);
  assert.match(queries[0].sql, /update_transport = 'webhook'/);
  assert.deepEqual(queries[0].params, [42]);
});

test('customer webhook secret resolver derives the secret only for a webhook-enabled bot', async () => {
  const { createCustomerWebhookSecretResolver } = require('../webhook');
  const key = Buffer.alloc(32, 5);
  const record = { id: 7, token_ciphertext: 'encrypted' };
  const resolveSecret = createCustomerWebhookSecretResolver({
    pool: {
      async query(sql) {
        assert.match(sql, /update_transport = 'webhook'/);
        return { rowCount: 1, rows: [record] };
      }
    },
    decryptToken: row => row.token_ciphertext === 'encrypted' ? 'bot-token' : '',
    encryptionKey: key
  });

  assert.equal(await resolveSecret(7), deriveTelegramWebhookSecret(7, 'bot-token', key));
});
