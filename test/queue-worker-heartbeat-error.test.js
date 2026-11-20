'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueueWorker } = require('../queue-worker');

test('queue worker does not write completion or failure after a heartbeat error', async () => {
  let claimed = false;
  let renewalStarted;
  let signalRenewalStarted;
  let completeCalls = 0;
  let failCalls = 0;
  const keepAlive = setInterval(() => {}, 1000);
  const renewalStartedGate = new Promise(resolve => { signalRenewalStarted = resolve; });
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      if (claimed) return null;
      claimed = true;
      return { id: 94, job_type: 'test.heartbeat.error', attempts: 1 };
    },
    async renewPlatformJobLease() {
      renewalStarted = true;
      signalRenewalStarted();
      throw new Error('temporary database disconnect');
    },
    async completePlatformJob() { completeCalls += 1; },
    async failPlatformJob() { failCalls += 1; }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'heartbeat-error-worker',
    handlers: {
      'test.heartbeat.error': async () => {
        await renewalStartedGate;
        return { ok: true };
      }
    },
    queueApi,
    leaseSeconds: 10,
    leaseRenewalIntervalMs: 100,
    logger: { log() {}, warn() {}, error() {} }
  });

  try {
    const processing = worker.processOne();
    await renewalStartedGate;
    assert.equal(renewalStarted, true);
    assert.equal(await processing, true);
    assert.equal(completeCalls, 0, 'worker must not complete after heartbeat failure');
    assert.equal(failCalls, 0, 'worker must not record failure after heartbeat failure');
  } finally {
    clearInterval(keepAlive);
  }
});
