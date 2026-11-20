'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotRuntime } = require('../bot-runtime');

function fixturePool(records) {
  const statuses = new Map();
  return {
    statuses,
    async query(sql, params = []) {
      if (sql.includes('FROM telegram_bots') && sql.includes('WHERE id = $1')) {
        const row = records.find(item => String(item.id) === String(params[0]) && item.active && (item.update_transport || 'polling') === 'polling');
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes('FROM telegram_bots') && sql.includes('WHERE active = TRUE')) {
        const pollingRecords = records.filter(row => row.active && (row.update_transport || 'polling') === 'polling');
        return { rowCount: pollingRecords.length, rows: pollingRecords };
      }
      if (sql.includes('UPDATE bot_runtime_status')) {
        const current = statuses.get(String(params[0]));
        if (!current || current.worker_id !== params[2]) return { rowCount: 0, rows: [] };
        statuses.set(String(params[0]), { ...current, status: params[1], worker_id: params[2], error: params[4] });
        return { rowCount: 1, rows: [{ bot_id: params[0] }] };
      }
      if (sql.includes('INSERT INTO bot_runtime_status')) {
        statuses.set(String(params[0]), { status: params[1], worker_id: params[2], error: params[4] });
        return { rowCount: 1, rows: [] };
      }
      throw new Error('Unexpected SQL in test: ' + sql.slice(0, 80));
    }
  };
}

function fixtureBotFactory() {
  const started = [];
  const stopped = [];
  return {
    started,
    stopped,
    create(record) {
      let finish;
      return {
        async start({ onStart }) {
          started.push(String(record.id));
          onStart({ username: record.username });
          await new Promise(resolve => { finish = resolve; });
        },
        async stop() {
          stopped.push(String(record.id));
          if (finish) finish();
        }
      };
    }
  };
}

test('starts one bot on demand, does not duplicate it, and stops it independently', async () => {
  const records = [{ id: 1, name: 'One', username: 'one_bot', active: true, token_ciphertext: 'x' }];
  const pool = fixturePool(records);
  const bots = fixtureBotFactory();
  const runtime = createBotRuntime({
    pool,
    decryptToken: () => 'token',
    createCustomerBot: record => bots.create(record),
    logger: { log() {}, error() {} },
    heartbeatIntervalMs: 100000
  });

  await runtime.startBotById(1);
  await new Promise(resolve => setImmediate(resolve));
  await runtime.startBotById(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bots.started, ['1']);
  assert.equal(runtime.getBotRuntimeStatus(1), 'running');

  await runtime.stopBotById(1);
  assert.equal(runtime.getBotRuntimeStatus(1), 'stopped');
  assert.deepEqual(bots.stopped, ['1']);
});

test('enforces configured maximum active bot capacity', async () => {
  const records = [1, 2].map(id => ({
    id, name: 'Bot ' + id, username: 'bot_' + id, active: true, token_ciphertext: 'x'
  }));
  const pool = fixturePool(records);
  const bots = fixtureBotFactory();
  const runtime = createBotRuntime({
    pool,
    decryptToken: () => 'token',
    createCustomerBot: record => bots.create(record),
    logger: { log() {}, error() {} },
    maxBots: 1,
    heartbeatIntervalMs: 100000
  });

  const result = await runtime.startBotRuntime();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, { found: 2, started: 1, capacity: 1 });
  assert.deepEqual(bots.started, ['1']);
  await assert.rejects(runtime.startBotById(2), /Maximum active customer bots reached/);
  await runtime.stopBotRuntime();
});


test('never starts webhook transport bots through polling runtime entry points', async () => {
  const records = [
    { id: 1, name: 'Polling', username: 'polling_bot', active: true, update_transport: 'polling', token_ciphertext: 'x' },
    { id: 2, name: 'Webhook', username: 'webhook_bot', active: true, update_transport: 'webhook', token_ciphertext: 'y' }
  ];
  const pool = fixturePool(records);
  const bots = fixtureBotFactory();
  const runtime = createBotRuntime({
    pool,
    decryptToken: () => 'token',
    createCustomerBot: record => bots.create(record),
    logger: { log() {}, error() {} },
    heartbeatIntervalMs: 100000
  });

  await assert.rejects(runtime.startBotById(2), /Bot not found, inactive, missing encrypted token, or not configured for polling/);
  const result = await runtime.startBotRuntime();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result, { found: 1, started: 1, capacity: 100 });
  assert.deepEqual(bots.started, ['1']);
  await runtime.stopBotRuntime();
});

test('returns not_loaded for bots absent from this runtime', () => {
  const runtime = createBotRuntime({
    pool: fixturePool([]),
    decryptToken: () => 'token',
    createCustomerBot: () => ({}),
    logger: { log() {}, error() {} }
  });
  assert.equal(runtime.getBotRuntimeStatus(99), 'not_loaded');
});

test('default capacity accepts 100 bots and rejects the 101st', async () => {
  const records = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    name: 'Bot ' + (index + 1),
    username: 'bot_' + (index + 1),
    active: true,
    token_ciphertext: 'x'
  }));
  const pool = fixturePool(records);
  const bots = fixtureBotFactory();
  const runtime = createBotRuntime({
    pool,
    decryptToken: () => 'token',
    createCustomerBot: record => bots.create(record),
    logger: { log() {}, error() {} },
    heartbeatIntervalMs: 100000
  });

  const result = await runtime.startBotRuntime();
  assert.deepEqual(result, { found: 101, started: 100, capacity: 100 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bots.started.length, 100);
  await assert.rejects(runtime.startBotById(101), /Maximum active customer bots reached/);
  await runtime.stopBotRuntime();
});


test('stops a customer bot when another worker takes its lease and never overwrites the new owner', async () => {
  const records = [{ id: 7, name: 'Lease test', username: 'lease_test_bot', active: true, token_ciphertext: 'x' }];
  const pool = fixturePool(records);
  pool.statuses.set('7', { status: 'starting', worker_id: 'worker-a', error: null });
  const bots = fixtureBotFactory();
  const runtime = createBotRuntime({
    pool,
    decryptToken: () => 'token',
    createCustomerBot: record => bots.create(record),
    logger: { log() {}, error() {} },
    workerId: 'worker-a',
    requireLease: true,
    leaseSeconds: 30,
    heartbeatIntervalMs: 10
  });

  await runtime.startBotById(7);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bots.started, ['7']);

  // Simulate an expired lease being claimed by a different worker.
  pool.statuses.set('7', { status: 'starting', worker_id: 'worker-b', error: null });
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.deepEqual(bots.stopped, ['7']);
  assert.equal(pool.statuses.get('7').worker_id, 'worker-b');
  assert.equal(runtime.getRuntimeSnapshot()[0].leaseLost, true);
  await runtime.stopBotRuntime();
});

test('fails closed when a lease-required runtime has no matching owner row', async () => {
  const records = [{ id: 8, name: 'Unowned', username: 'unowned_bot', active: true, token_ciphertext: 'x' }];
  const pool = fixturePool(records);
  const bots = fixtureBotFactory();
  const runtime = createBotRuntime({
    pool,
    decryptToken: () => 'token',
    createCustomerBot: record => bots.create(record),
    logger: { log() {}, error() {} },
    workerId: 'worker-missing',
    requireLease: true,
    leaseSeconds: 30,
    heartbeatIntervalMs: 100000
  });

  await runtime.startBotById(8);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bots.started, []);
  assert.equal(runtime.getRuntimeSnapshot()[0].leaseLost, true);
  await runtime.stopBotRuntime();
});
