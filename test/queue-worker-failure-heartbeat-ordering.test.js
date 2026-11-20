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

test('queue worker waits for a successful heartbeat before recording handler failure', async () => {
  const heartbeatStarted = deferred();
  const releaseHeartbeat = deferred();
  const handlerStarted = deferred();
  const rejectHandler = deferred();
  let failCalls = 0;
  const keepAlive = setInterval(() => {}, 1000);
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      return { id: 97, job_type: 'test.failure.heartbeat', attempts: 1 };
    },
    async renewPlatformJobLease() {
      heartbeatStarted.resolve();
      await releaseHeartbeat.promise;
      return true;
    },
    async completePlatformJob() { assert.fail('failed handler must not complete'); },
    async failPlatformJob(_pool, args) {
      assert.equal(args.jobId, 97);
      assert.match(args.error.message, /expected handler failure/);
      failCalls += 1;
    }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'failure-heartbeat-worker',
    handlers: {
      'test.failure.heartbeat': async () => {
        handlerStarted.resolve();
        await rejectHandler.promise;
      }
    },
    queueApi,
    leaseSeconds: 10,
    leaseRenewalIntervalMs: 100,
    logger: { log() {}, warn() {}, error() {} }
  });

  try {
    const processing = worker.processOne();
    await handlerStarted.promise;
    await heartbeatStarted.promise;
    rejectHandler.reject(new Error('expected handler failure'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(failCalls, 0, 'failure write must wait for the in-flight heartbeat');

    releaseHeartbeat.resolve();
    assert.equal(await processing, true);
    assert.equal(failCalls, 1, 'failure may be recorded after lease renewal succeeds');
  } finally {
    clearInterval(keepAlive);
  }
});

test('queue worker does not record handler failure after heartbeat reports lease loss', async () => {
  const heartbeatStarted = deferred();
  const handlerStarted = deferred();
  const rejectHandler = deferred();
  let failCalls = 0;
  const keepAlive = setInterval(() => {}, 1000);
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      return { id: 98, job_type: 'test.failure.lease.lost', attempts: 1 };
    },
    async renewPlatformJobLease() {
      heartbeatStarted.resolve();
      return false;
    },
    async completePlatformJob() { assert.fail('failed handler must not complete'); },
    async failPlatformJob() { failCalls += 1; }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'failure-lease-lost-worker',
    handlers: {
      'test.failure.lease.lost': async () => {
        handlerStarted.resolve();
        await heartbeatStarted.promise;
        await rejectHandler.promise;
      }
    },
    queueApi,
    leaseSeconds: 10,
    leaseRenewalIntervalMs: 100,
    logger: { log() {}, warn() {}, error() {} }
  });

  try {
    const processing = worker.processOne();
    await handlerStarted.promise;
    await heartbeatStarted.promise;
    rejectHandler.reject(new Error('handler failed after lease loss'));
    assert.equal(await processing, true);
    assert.equal(failCalls, 0, 'worker must not record failure after lease loss');
  } finally {
    clearInterval(keepAlive);
  }
});
