'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueueWorker } = require('../queue-worker');

test('queue worker waits for an in-flight lease heartbeat before completing a job', async () => {
  let claimed = false;
  let renewalStarted = false;
  let releaseRenewal;
  let completeCalls = 0;
  let failCalls = 0;
  let signalRenewalStarted;
  const keepAlive = setInterval(() => {}, 1000);
  const renewalStartedGate = new Promise(resolve => { signalRenewalStarted = resolve; });
  const renewalGate = new Promise(resolve => { releaseRenewal = resolve; });
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      if (claimed) return null;
      claimed = true;
      return { id: 93, job_type: 'test.heartbeat.race', attempts: 1 };
    },
    async renewPlatformJobLease() {
      renewalStarted = true;
      signalRenewalStarted();
      return renewalGate;
    },
    async completePlatformJob() { completeCalls += 1; },
    async failPlatformJob() { failCalls += 1; }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'heartbeat-race-worker',
    handlers: {
      'test.heartbeat.race': async () => {
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
    let settled = false;
    const processing = worker.processOne().then(result => {
      settled = true;
      return result;
    });

    await renewalStartedGate;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(renewalStarted, true);
    assert.equal(settled, false, 'job processing must wait for the active heartbeat');
    assert.equal(completeCalls, 0, 'job must not complete before heartbeat result is known');

    releaseRenewal(false);
    assert.equal(await processing, true);
    assert.equal(completeCalls, 0, 'job must not complete after the heartbeat reports lease loss');
    assert.equal(failCalls, 0, 'job must not be failed by a worker that lost its lease');
  } finally {
    clearInterval(keepAlive);
  }
});
