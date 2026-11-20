'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueueWorker } = require('../queue-worker');

test('queue worker does not claim a new job when stop is requested during recovery', async () => {
  let releaseRecovery;
  let recoveryStarted = false;
  let claims = 0;
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'stop-before-claim-worker',
    handlers: { 'test.stop': async () => ({}) },
    queueApi: {
      async recoverExpiredPlatformJobs() {
        recoveryStarted = true;
        await recoveryGate;
        return [];
      },
      async claimPlatformJob() {
        claims += 1;
        return null;
      }
    },
    pollIntervalMs: 100,
    logger: { log() {}, warn() {}, error() {} }
  });

  const running = worker.start();
  const deadline = Date.now() + 2000;
  while (!recoveryStarted && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(recoveryStarted, true, 'worker should enter recovery');

  const stopping = worker.stop();
  releaseRecovery();
  await stopping;
  await running;

  assert.equal(claims, 0, 'shutdown must prevent claiming another job after recovery');
});
