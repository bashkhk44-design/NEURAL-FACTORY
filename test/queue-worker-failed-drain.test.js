'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueueWorker } = require('../queue-worker');

test('queue worker records an active job failure before graceful stop resolves', async () => {
  let handlerStarted = false;
  let rejectHandler;
  let failureRecorded = false;
  const handlerGate = new Promise((_resolve, reject) => { rejectHandler = reject; });
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      if (handlerStarted) return null;
      return { id: 92, job_type: 'test.drain.failure', attempts: 2 };
    },
    async renewPlatformJobLease() { return true; },
    async completePlatformJob() { assert.fail('failed job must not complete'); },
    async failPlatformJob(_pool, args) {
      assert.equal(args.jobId, 92);
      assert.equal(args.workerId, 'failed-drain-worker');
      assert.match(args.error.message, /expected handler failure/);
      failureRecorded = true;
    }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'failed-drain-worker',
    handlers: {
      'test.drain.failure': async () => {
        handlerStarted = true;
        await handlerGate;
      }
    },
    queueApi,
    leaseSeconds: 10,
    leaseRenewalIntervalMs: 100,
    logger: { log() {}, warn() {}, error() {} }
  });

  const running = worker.start();
  const deadline = Date.now() + 2000;
  while (!handlerStarted && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(handlerStarted, true, 'worker should begin the active job');

  let stopResolved = false;
  const stopping = worker.stop().then(() => { stopResolved = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(stopResolved, false, 'stop must wait for the active handler');
  assert.equal(failureRecorded, false, 'failure must not be recorded before handler settles');

  rejectHandler(new Error('expected handler failure'));
  await stopping;
  await running;

  assert.equal(failureRecorded, true, 'failure must be persisted before stop resolves');
});
