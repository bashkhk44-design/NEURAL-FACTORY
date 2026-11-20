'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoRemediator } = require('../auto-remediation');

function createPool({ bot, history = [] }) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') return { rows: [] };
      if (normalized.includes('FROM telegram_bots b')) return { rows: bot ? [bot] : [], rowCount: bot ? 1 : 0 };
      if (normalized.includes('FROM bot_auto_remediation_attempts')) return { rows: history, rowCount: history.length };
      if (normalized.includes('INSERT INTO bot_auto_remediation_attempts')) return { rows: [{ id: 71 }], rowCount: 1 };
      if (normalized.includes('INSERT INTO bot_runtime_commands')) return { rows: [{ id: 91 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { calls, async connect() { return client; } };
}

test('queues one durable restart for a stale active bot', async () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const pool = createPool({
    bot: { id: '42', active: true, token_ciphertext: 'cipher', status: 'running', last_heartbeat_at: new Date(now - 180000) }
  });
  const service = createAutoRemediator({ pool, now: () => now });
  const result = await service.consider('42');
  assert.equal(result.queued, true);
  assert.equal(result.action, 'restart');
  assert.equal(result.attemptId, '71');
  assert.equal(result.commandId, '91');
  assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), true);
  assert.equal(pool.calls.some(call => call.sql.includes('INSERT INTO bot_runtime_commands')), true);
});

test('does not queue when bot is missing, inactive, or token is missing', async () => {
  const now = Date.now();
  for (const bot of [
    null,
    { id: '42', active: false, token_ciphertext: 'cipher', status: 'stopped', last_heartbeat_at: new Date(now) },
    { id: '42', active: true, token_ciphertext: null, status: 'stopped', last_heartbeat_at: new Date(now) }
  ]) {
    const pool = createPool({ bot });
    const result = await createAutoRemediator({ pool }).consider('42');
    assert.equal(result.queued, undefined);
    assert.equal(pool.calls.some(call => call.sql.includes('INSERT INTO bot_runtime_commands')), false);
  }
});

test('blocks unsafe states and already pending or failed repairs', async () => {
  const now = Date.now();
  const base = { id: '42', active: true, token_ciphertext: 'cipher', last_heartbeat_at: new Date(now) };
  for (const status of ['conflict', 'unauthorized', 'error', 'retrying', 'unknown']) {
    const pool = createPool({ bot: { ...base, status } });
    const result = await createAutoRemediator({ pool }).consider('42');
    assert.equal(result.eligible, false);
    assert.equal(pool.calls.some(call => call.sql.includes('INSERT INTO bot_runtime_commands')), false);
  }
  for (const status of ['queued', 'processing', 'failed']) {
    const pool = createPool({
      bot: { ...base, status: 'stopped' },
      history: [{ status, at: new Date(now - 10 * 60 * 1000) }]
    });
    const result = await createAutoRemediator({ pool, now: () => now }).consider('42');
    assert.equal(result.eligible, false);
    assert.equal(pool.calls.some(call => call.sql.includes('INSERT INTO bot_runtime_commands')), false);
  }
});

test('rejects invalid bot ids without connecting to the database', async () => {
  const pool = createPool({ bot: null });
  const result = await createAutoRemediator({ pool }).consider('0; DROP TABLE telegram_bots');
  assert.deepEqual(result, { eligible: false, reason: 'invalid_bot_id' });
  assert.equal(pool.calls.length, 0);
});
