'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeMonitor } = require('../runtime-monitor');

test('runtime monitor reports healthy bots and stale or failed bots without changing data', async () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  let queries = 0;
  const pool = {
    async query(sql) {
      queries += 1;
      if (/FROM bot_worker_status/.test(sql)) {
        return { rows: [
          { worker_id: 'worker-a', status: 'running', capacity: 25, last_heartbeat_at: new Date(now - 5000) },
          { worker_id: 'worker-b', status: 'stopped', capacity: 25, last_heartbeat_at: new Date(now - 5000) },
          { worker_id: 'worker-c', status: 'running', capacity: 25, last_heartbeat_at: new Date(now - 180000) }
        ] };
      }
      assert.match(sql, /LEFT JOIN bot_runtime_status/);
      return { rows: [
        { id: 1, name: 'healthy', status: 'running', worker_id: 'worker-a', last_heartbeat_at: new Date(now - 10000), last_error_code: null },
        { id: 2, name: 'stale', status: 'running', worker_id: 'worker-a', last_heartbeat_at: new Date(now - 180000), last_error_code: null },
        { id: 3, name: 'failed', status: 'error', worker_id: 'worker-b', last_heartbeat_at: new Date(now - 5000), last_error_code: 'START_FAILED' },
        { id: 4, name: 'not-seen', status: null, worker_id: null, last_heartbeat_at: null, last_error_code: null }
      ] };
    }
  };
  const monitor = createRuntimeMonitor({
    pool, staleAfterSeconds: 90, now: () => now,
    logger: { log() {}, error() {} }
  });

  const report = await monitor.pollOnce();
  assert.equal(queries, 2);
  assert.equal(report.activeBots, 4);
  assert.equal(report.healthyBots, 1);
  assert.deepEqual(report.issues.map(item => item.reason), [
    'stale_heartbeat', 'error', 'missing_heartbeat'
  ]);
  assert.equal(report.workers.length, 3);
  assert.equal(report.workers.find(item => item.workerId === 'worker-a').health, 'healthy');
  assert.equal(report.workers.find(item => item.workerId === 'worker-b').health, 'stopped');
  assert.equal(report.workers.find(item => item.workerId === 'worker-c').health, 'stale_heartbeat');
});

test('runtime monitor rejects unsafe polling intervals', () => {
  assert.throws(() => createRuntimeMonitor({
    pool: { query: async () => ({ rows: [] }) }, intervalMs: 100
  }), /intervalMs/);
});

test('runtime monitor only queues repairs when explicit opt-in is enabled', async () => {
  let calls = 0;
  const pool = {
    async query(sql) {
      if (/FROM bot_worker_status/.test(sql)) return { rows: [] };
      return { rows: [
        { id: 77, name: 'stale-bot', status: 'running', worker_id: 'worker-x',
          last_heartbeat_at: new Date(Date.now() - 180000), last_error_code: null }
      ] };
    }
  };
  const autoRemediator = {
    async consider(botId) {
      calls += 1;
      assert.equal(botId, '77');
      return { eligible: true, queued: true, attemptId: '1', commandId: '2' };
    }
  };
  const logger = { log() {}, error() {} };

  const readOnly = createRuntimeMonitor({ pool, logger, autoRemediator, autoRemediationEnabled: false });
  const readOnlyReport = await readOnly.check();
  assert.equal(calls, 0);
  assert.deepEqual(readOnlyReport.remediation, []);

  const enabled = createRuntimeMonitor({ pool, logger, autoRemediator, autoRemediationEnabled: true });
  const enabledReport = await enabled.check();
  assert.equal(calls, 1);
  assert.equal(enabledReport.remediation[0].queued, true);
});
