'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimNextBot, createCustomerBotWorker } = require('../customer-bot-worker');

test('claims the next eligible bot transactionally with SKIP LOCKED', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT b.id')) return { rowCount: 1, rows: [{ id: 42 }] };
      return { rowCount: 1, rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  const pool = { async connect() { return client; } };

  const id = await claimNextBot(pool, 'worker-test', 90);
  assert.equal(id, '42');
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /FOR UPDATE OF b SKIP LOCKED/);
  assert.match(calls[1].sql, /b\.update_transport = 'polling'/);
  assert.match(calls[2].sql, /ON CONFLICT \(bot_id\) DO UPDATE/);
  assert.match(calls[2].sql, /last_heartbeat_at < NOW\(\) - \(\$3::int/);
  assert.deepEqual(calls[2].params, ['42', 'worker-test', 90]);
  assert.equal(calls[3].sql, 'COMMIT');
  assert.equal(calls[4].sql, 'RELEASE');
});

test('does not claim another bot when worker capacity is full but still checks manager commands', async () => {
  let botClaims = 0;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
          if (sql.includes('SELECT c.id, c.bot_id')) return { rowCount: 0, rows: [] };
          if (sql.includes('SELECT b.id')) { botClaims += 1; throw new Error('must not claim another bot'); }
          throw new Error('Unexpected SQL: ' + sql.slice(0, 80));
        },
        release() {}
      };
    }
  };
  const runtime = {
    getRuntimeSnapshot: () => [
      { id: '1', status: 'running' },
      { id: '2', status: 'retrying' }
    ],
    async startBotById() {},
    async stopBotById() {},
    async stopBotRuntime() {}
  };
  const worker = createCustomerBotWorker({
    pool, runtime, workerId: 'worker-full', capacity: 2,
    leaseSeconds: 90, pollIntervalMs: 500,
    logger: { log() {}, error() {} }
  });
  assert.equal(await worker.runOnce(), false);
  assert.equal(botClaims, 0);
});

test('worker capacity and lease settings are bounded', () => {
  const runtime = { getRuntimeSnapshot: () => [], startBotById() {}, stopBotRuntime() {} };
  assert.throws(() => createCustomerBotWorker({
    pool: { connect() {} }, runtime, capacity: 101
  }), /capacity must be between 1 and 100/);
  assert.throws(() => createCustomerBotWorker({
    pool: { connect() {} }, runtime, leaseSeconds: 10
  }), /leaseSeconds must be at least 30 seconds/);
});


test('does not steal a bot if its previous worker renews the lease after candidate selection', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT b.id')) return { rowCount: 1, rows: [{ id: 42 }] };
      if (sql.includes('INSERT INTO bot_runtime_status')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  const pool = { async connect() { return client; } };

  const id = await claimNextBot(pool, 'worker-new', 90);
  assert.equal(id, null);
  assert.match(calls[2].sql, /bot_runtime_status\.last_heartbeat_at < NOW\(\)/);
  assert.deepEqual(calls[2].params, ['42', 'worker-new', 90]);
  assert.equal(calls[3].sql, 'COMMIT');
  assert.equal(calls[4].sql, 'RELEASE');
});
