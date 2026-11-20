'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueueWorker } = require('../queue-worker');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, message);
}

test('queue worker does not write job state after a heartbeat reports lease loss', async () => {
  const heartbeatStarted = deferred();
  let completeCalls = 0;
  let failCalls = 0;
  const keepAlive = setInterval(() => {}, 1000);
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      return { id: 95, job_type: 'test.lease.lost', attempts: 1 };
    },
    async renewPlatformJobLease() {
      heartbeatStarted.resolve();
      return false;
    },
    async completePlatformJob() { completeCalls += 1; },
    async failPlatformJob() { failCalls += 1; }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'lease-lost-worker',
    handlers: {
      'test.lease.lost': async () => {
        await heartbeatStarted.promise;
        return { ok: true };
      }
    },
    queueApi,
    leaseSeconds: 10,
    leaseRenewalIntervalMs: 100,
    logger: { log() {}, warn() {}, error() {} }
  });

  try {
    assert.equal(await worker.processOne(), true);
    assert.equal(completeCalls, 0, 'worker must not complete after lease loss');
    assert.equal(failCalls, 0, 'worker must not record failure after lease loss');
  } finally {
    clearInterval(keepAlive);
  }
});

test('queue worker does not overlap lease renewals and drains the active renewal', async () => {
  const heartbeatStarted = deferred();
  const releaseHeartbeat = deferred();
  const releaseHandler = deferred();
  let renewCalls = 0;
  let activeRenewals = 0;
  let maxActiveRenewals = 0;
  let completeCalls = 0;
  const keepAlive = setInterval(() => {}, 1000);
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      return { id: 96, job_type: 'test.lease.renewal', attempts: 1 };
    },
    async renewPlatformJobLease() {
      renewCalls += 1;
      activeRenewals += 1;
      maxActiveRenewals = Math.max(maxActiveRenewals, activeRenewals);
      heartbeatStarted.resolve();
      await releaseHeartbeat.promise;
      activeRenewals -= 1;
      return true;
    },
    async completePlatformJob() { completeCalls += 1; },
    async failPlatformJob() { assert.fail('job must not fail'); }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'renewal-drain-worker',
    handlers: {
      'test.lease.renewal': async () => {
        await releaseHandler.promise;
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
    await heartbeatStarted.promise;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(renewCalls, 1, 'a slow renewal must not overlap with another renewal');
    assert.equal(maxActiveRenewals, 1, 'at most one lease renewal may be in flight');

    releaseHandler.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(completeCalls, 0, 'completion must wait for the in-flight renewal');

    releaseHeartbeat.resolve();
    assert.equal(await processing, true);
    assert.equal(completeCalls, 1, 'job should complete after the renewal succeeds');
    assert.equal(maxActiveRenewals, 1);
  } finally {
    clearInterval(keepAlive);
  }
});


test('queue worker passes its fenced lease context to update handlers', async () => {
  let received;
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      return { id: 97, job_type: 'test.context', attempts: 1 };
    },
    async renewPlatformJobLease() { return true; },
    async completePlatformJob() {},
    async failPlatformJob() { assert.fail('job must not fail'); }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'context-worker',
    handlers: {
      'test.context': async (job, context) => {
        received = { jobId: job.id, workerId: context.workerId, leaseSeconds: context.leaseSeconds };
        assert.equal(context.isLeaseLost(), false);
        return { ok: true };
      }
    },
    queueApi,
    leaseSeconds: 30,
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(await worker.processOne(), true);
  assert.deepEqual(received, { jobId: 97, workerId: 'context-worker', leaseSeconds: 30 });
});
