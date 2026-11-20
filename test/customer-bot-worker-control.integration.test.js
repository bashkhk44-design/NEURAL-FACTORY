'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createCustomerBotWorker } = require('../customer-bot-worker');

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl && process.env.DATABASE_SSL === 'disable');

test('worker consumes a manager start command through the durable command table', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 2 });
  const workerId = 'manager-control-integration';
  let started = 0;
  try {
    const bot = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('control fixture', 'control_fixture_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    const botId = bot.rows[0].id;
    await pool.query(`
      INSERT INTO bot_runtime_commands (bot_id, action, status, requested_by)
      VALUES ($1, 'start', 'queued', 'integration-test')
    `, [botId]);

    const runtime = {
      getRuntimeSnapshot: () => [],
      async startBotById(id) { assert.equal(String(id), String(botId)); started += 1; },
      async stopBotById() {},
      async stopBotRuntime() {}
    };
    const worker = createCustomerBotWorker({
      pool, runtime, workerId, capacity: 2, leaseSeconds: 90,
      pollIntervalMs: 500, logger: { log() {}, error() {} }
    });

    assert.equal(await worker.runOnce(), true);
    assert.equal(started, 1);
    const result = await pool.query(
      'SELECT status FROM bot_runtime_commands WHERE bot_id = $1',
      [botId]
    );
    assert.equal(result.rows[0].status, 'completed');
    const status = await pool.query(
      'SELECT worker_id, status FROM bot_runtime_status WHERE bot_id = $1',
      [botId]
    );
    assert.equal(status.rows[0].worker_id, workerId);
    assert.equal(status.rows[0].status, 'starting');
  } finally {
    await pool.query("DELETE FROM telegram_bots WHERE name = 'control fixture'");
    await pool.end();
  }
});

test('worker reclaims a manager command abandoned by a crashed worker', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 2 });
  const workerId = 'manager-command-recovery';
  let started = 0;
  try {
    const bot = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('recovery fixture', 'recovery_fixture_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    const botId = bot.rows[0].id;
    await pool.query(`
      INSERT INTO bot_runtime_commands
        (bot_id, action, status, requested_by, claimed_by, claimed_at)
      VALUES ($1, 'start', 'processing', 'integration-test', 'dead-worker', NOW() - INTERVAL '3 minutes')
    `, [botId]);
    const runtime = {
      getRuntimeSnapshot: () => [],
      async startBotById(id) { assert.equal(String(id), String(botId)); started += 1; },
      async stopBotById() {},
      async stopBotRuntime() {}
    };
    const worker = createCustomerBotWorker({
      pool, runtime, workerId, capacity: 2, leaseSeconds: 30,
      pollIntervalMs: 500, logger: { log() {}, error() {} }
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(started, 1);
    const result = await pool.query(
      'SELECT status, claimed_by, attempts FROM bot_runtime_commands WHERE bot_id = $1',
      [botId]
    );
    assert.equal(result.rows[0].status, 'completed');
    assert.equal(result.rows[0].claimed_by, workerId);
    assert.equal(Number(result.rows[0].attempts), 1);
  } finally {
    await pool.query("DELETE FROM telegram_bots WHERE name = 'recovery fixture'");
    await pool.end();
  }
});


test('worker marks a queued automatic remediation attempt succeeded after restart', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 3 });
  let botId;
  try {
    const bot = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('auto remediation success fixture', 'auto_remediation_success_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    botId = bot.rows[0].id;
    const attempt = await pool.query(`
      INSERT INTO bot_auto_remediation_attempts (bot_id, status, reason)
      VALUES ($1, 'queued', 'stale_heartbeat') RETURNING id
    `, [botId]);
    await pool.query(`
      INSERT INTO bot_runtime_commands
        (bot_id, action, status, requested_by, auto_remediation_attempt_id)
      VALUES ($1, 'restart', 'queued', 'auto-remediation', $2)
    `, [botId, attempt.rows[0].id]);

    const runtime = {
      getRuntimeSnapshot: () => [],
      async startBotById(id) {
        assert.equal(String(id), String(botId));
        await pool.query("UPDATE bot_runtime_status SET status = 'running', last_heartbeat_at = NOW() WHERE bot_id = $1", [botId]);
      },
      async stopBotById() {},
      async stopBotRuntime() {}
    };
    const worker = createCustomerBotWorker({
      pool, runtime, workerId: 'auto-remediation-success-worker',
      capacity: 2, leaseSeconds: 90, pollIntervalMs: 500,
      logger: { log() {}, error() {} }
    });
    assert.equal(await worker.runOnce(), true);
    const result = await pool.query(
      'SELECT status, finished_at FROM bot_auto_remediation_attempts WHERE id = $1',
      [attempt.rows[0].id]
    );
    assert.equal(result.rows[0].status, 'succeeded');
    assert.ok(result.rows[0].finished_at);
  } finally {
    if (botId) await pool.query('DELETE FROM telegram_bots WHERE id = $1', [botId]);
    await pool.end();
  }
});

test('worker marks an automatic remediation attempt failed when restart fails', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 3 });
  let botId;
  try {
    const bot = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('auto remediation failure fixture', 'auto_remediation_failure_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    botId = bot.rows[0].id;
    const attempt = await pool.query(`
      INSERT INTO bot_auto_remediation_attempts (bot_id, status, reason)
      VALUES ($1, 'queued', 'stale_heartbeat') RETURNING id
    `, [botId]);
    await pool.query(`
      INSERT INTO bot_runtime_commands
        (bot_id, action, status, requested_by, auto_remediation_attempt_id)
      VALUES ($1, 'restart', 'queued', 'auto-remediation', $2)
    `, [botId, attempt.rows[0].id]);

    const runtime = {
      getRuntimeSnapshot: () => [],
      async startBotById() { throw new Error('fixture restart failure'); },
      async stopBotById() {},
      async stopBotRuntime() {}
    };
    const worker = createCustomerBotWorker({
      pool, runtime, workerId: 'auto-remediation-failure-worker',
      capacity: 2, leaseSeconds: 90, pollIntervalMs: 500,
      logger: { log() {}, error() {} }
    });
    assert.equal(await worker.runOnce(), true);
    const result = await pool.query(
      'SELECT status, error_message, finished_at FROM bot_auto_remediation_attempts WHERE id = $1',
      [attempt.rows[0].id]
    );
    assert.equal(result.rows[0].status, 'failed');
    assert.match(result.rows[0].error_message, /fixture restart failure/);
    assert.ok(result.rows[0].finished_at);
  } finally {
    if (botId) await pool.query('DELETE FROM telegram_bots WHERE id = $1', [botId]);
    await pool.end();
  }
});


test('worker recovers an abandoned automatic remediation after a worker crash', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 3 });
  let botId;
  try {
    const bot = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('auto remediation crash recovery fixture', 'auto_remediation_crash_fixture_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    botId = bot.rows[0].id;
    const attempt = await pool.query(`
      INSERT INTO bot_auto_remediation_attempts
        (bot_id, status, reason, started_at)
      VALUES ($1, 'processing', 'stale_heartbeat', NOW() - INTERVAL '3 minutes')
      RETURNING id
    `, [botId]);
    await pool.query(`
      INSERT INTO bot_runtime_commands
        (bot_id, action, status, requested_by, claimed_by, claimed_at, attempts, auto_remediation_attempt_id)
      VALUES ($1, 'restart', 'processing', 'auto-remediation', 'crashed-worker',
        NOW() - INTERVAL '3 minutes', 1, $2)
    `, [botId, attempt.rows[0].id]);

    const runtime = {
      getRuntimeSnapshot: () => [],
      async startBotById(id) {
        assert.equal(String(id), String(botId));
        await pool.query("UPDATE bot_runtime_status SET status = 'running', last_heartbeat_at = NOW() WHERE bot_id = $1", [botId]);
      },
      async stopBotById() {},
      async stopBotRuntime() {}
    };
    const worker = createCustomerBotWorker({
      pool, runtime, workerId: 'auto-remediation-recovery-worker',
      capacity: 2, leaseSeconds: 30, pollIntervalMs: 500,
      logger: { log() {}, error() {} }
    });
    assert.equal(await worker.runOnce(), true);

    const result = await pool.query(`
      SELECT a.status AS attempt_status, c.status AS command_status,
             c.claimed_by, c.attempts
      FROM bot_auto_remediation_attempts a
      JOIN bot_runtime_commands c ON c.auto_remediation_attempt_id = a.id
      WHERE a.id = $1
    `, [attempt.rows[0].id]);
    assert.equal(result.rows[0].attempt_status, 'succeeded');
    assert.equal(result.rows[0].command_status, 'completed');
    assert.equal(result.rows[0].claimed_by, 'auto-remediation-recovery-worker');
    assert.equal(Number(result.rows[0].attempts), 2);
  } finally {
    if (botId) await pool.query('DELETE FROM telegram_bots WHERE id = $1', [botId]);
    await pool.end();
  }
});


test('worker does not mark automatic recovery successful unless bot becomes healthy', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 3 });
  let botId;
  let stopped = 0;
  try {
    const bot = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('auto remediation unhealthy fixture', 'auto_remediation_unhealthy_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    botId = bot.rows[0].id;
    const attempt = await pool.query(`
      INSERT INTO bot_auto_remediation_attempts (bot_id, status, reason)
      VALUES ($1, 'queued', 'stale_heartbeat') RETURNING id
    `, [botId]);
    await pool.query(`
      INSERT INTO bot_runtime_commands
        (bot_id, action, status, requested_by, auto_remediation_attempt_id)
      VALUES ($1, 'restart', 'queued', 'auto-remediation', $2)
    `, [botId, attempt.rows[0].id]);

    const runtime = {
      getRuntimeSnapshot: () => [],
      async startBotById() {},
      async stopBotById() { stopped += 1; },
      async stopBotRuntime() {}
    };
    const worker = createCustomerBotWorker({
      pool, runtime, workerId: 'auto-remediation-unhealthy-worker',
      capacity: 2, leaseSeconds: 90, pollIntervalMs: 500,
      botReadyTimeoutMs: 1000, botReadyPollMs: 100,
      logger: { log() {}, error() {} }
    });
    assert.equal(await worker.runOnce(), true);
    const result = await pool.query(
      'SELECT status, error_message, finished_at FROM bot_auto_remediation_attempts WHERE id = $1',
      [attempt.rows[0].id]
    );
    assert.equal(result.rows[0].status, 'failed');
    assert.match(result.rows[0].error_message, /did not reach a healthy running state/);
    assert.ok(result.rows[0].finished_at);
    assert.equal(stopped, 2); // stop the old instance, then stop the unhealthy replacement
  } finally {
    if (botId) await pool.query('DELETE FROM telegram_bots WHERE id = $1', [botId]);
    await pool.end();
  }
});


test('worker cannot complete a manager command after its lease ownership changes', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 2 });
  let botId;
  const workerId = 'stale-command-owner-worker';
  try {
    const bot = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('stale command owner fixture', 'stale_command_owner_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    botId = bot.rows[0].id;
    const command = await pool.query(`
      INSERT INTO bot_runtime_commands (bot_id, action, status, requested_by)
      VALUES ($1, 'start', 'queued', 'integration-test')
      RETURNING id
    `, [botId]);

    const runtime = {
      getRuntimeSnapshot: () => [],
      async startBotById(id) {
        assert.equal(String(id), String(botId));
        await pool.query(`
          UPDATE bot_runtime_commands
          SET claimed_by = 'replacement-worker', claimed_at = NOW()
          WHERE id = $1 AND status = 'processing'
        `, [command.rows[0].id]);
      },
      async stopBotById() {},
      async stopBotRuntime() {}
    };
    const worker = createCustomerBotWorker({
      pool, runtime, workerId, capacity: 2, leaseSeconds: 30,
      pollIntervalMs: 500, logger: { log() {}, error() {} }
    });

    assert.equal(await worker.runOnce(), true);
    const result = await pool.query(
      'SELECT status, claimed_by FROM bot_runtime_commands WHERE id = $1',
      [command.rows[0].id]
    );
    assert.equal(result.rows[0].status, 'processing');
    assert.equal(result.rows[0].claimed_by, 'replacement-worker');
  } finally {
    if (botId) await pool.query('DELETE FROM telegram_bots WHERE id = $1', [botId]);
    await pool.end();
  }
});
