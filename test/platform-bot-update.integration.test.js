'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  enqueuePlatformBotUpdate,
  claimPlatformJob,
  completePlatformJob,
  failPlatformJob,
  recoverExpiredPlatformJobs,
  requeueDeadLetterPlatformBotUpdate
} = require('../platform-queue');
const { createPlatformBotUpdateHandler } = require('../platform-bot-update-handler');

test('platform bot updates enqueue atomically, deduplicate per identity, and dispatch only to their own runtime', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is required for the disposable PostgreSQL integration test' : false
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 5
  });
  const suffix = randomUUID();
  const updateId = Number(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
  const workerId = 'platform-inbox-ci-' + suffix;
  const keys = ['master', 'intake'].map(identity => 'telegram.' + identity + '.update:' + updateId);
  const inboxIds = [];
  const handled = { master: 0, intake: 0 };

  try {
    const master = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: updateId, message: { text: '/start', marker: suffix } }
    });
    const masterDuplicate = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: updateId, message: { text: '/duplicate' } }
    });
    const intake = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'intake',
      update: { update_id: updateId, message: { text: '/start', marker: suffix } }
    });
    assert.equal(master.duplicate, false);
    assert.equal(masterDuplicate.duplicate, true);
    assert.equal(intake.duplicate, false);
    assert.notEqual(String(master.id), String(intake.id));
    inboxIds.push(master.id, intake.id);

    const handler = createPlatformBotUpdateHandler({
      pool,
      leaseSeconds: 120,
      runtimes: {
        master: { async handleUpdate(update) { handled.master += 1; assert.equal(update.update_id, updateId); } },
        intake: { async handleUpdate(update) { handled.intake += 1; assert.equal(update.update_id, updateId); } }
      }
    });

    for (const identity of ['master', 'intake']) {
      const jobType = 'telegram.' + identity + '.update';
      const job = await claimPlatformJob(pool, workerId, [jobType]);
      assert.ok(job, 'expected queued ' + identity + ' update job');
      const result = await handler(job, {
        workerId,
        leaseSeconds: 120,
        isLeaseLost: () => false
      });
      assert.equal(result.processed, true);
      await completePlatformJob(pool, { jobId: job.id, workerId, result });
    }

    assert.deepEqual(handled, { master: 1, intake: 1 });
    const rows = await pool.query(
      'SELECT bot_identity, state FROM platform_bot_inbound_updates WHERE id = ANY($1::bigint[]) ORDER BY bot_identity',
      [inboxIds]
    );
    assert.deepEqual(rows.rows, [
      { bot_identity: 'intake', state: 'processed' },
      { bot_identity: 'master', state: 'processed' }
    ]);
    const jobs = await pool.query(
      'SELECT job_type, status FROM platform_jobs WHERE idempotency_key = ANY($1::text[]) ORDER BY job_type',
      [keys]
    );
    assert.deepEqual(jobs.rows, [
      { job_type: 'telegram.intake.update', status: 'completed' },
      { job_type: 'telegram.master.update', status: 'completed' }
    ]);
  } finally {
    await pool.query('DELETE FROM platform_jobs WHERE idempotency_key = ANY($1::text[])', [keys]);
    if (inboxIds.length) {
      await pool.query('DELETE FROM platform_bot_inbound_updates WHERE id = ANY($1::bigint[])', [inboxIds]);
    }
    await pool.end();
  }
});


test('platform Telegram updates preserve per-bot order and dead-letter jobs require explicit requeue', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is required for the disposable PostgreSQL integration test' : false
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 5
  });
  const suffix = randomUUID();
  const baseUpdateId = Number(BigInt(Date.now()) * 1000n + 50000n);
  const workerId = 'platform-order-ci-' + suffix;
  const identities = ['master', 'intake'];
  const updateIds = {
    master: [baseUpdateId, baseUpdateId + 1],
    intake: [baseUpdateId + 2, baseUpdateId + 3]
  };
  const deadLetterId = baseUpdateId + 10;
  const allKeys = [
    ...identities.flatMap(identity => updateIds[identity].map(id => 'telegram.' + identity + '.update:' + id)),
    'telegram.master.update:' + deadLetterId
  ];

  try {
    for (const identity of identities) {
      for (const updateId of updateIds[identity]) {
        await enqueuePlatformBotUpdate(pool, {
          botIdentity: identity,
          update: { update_id: updateId, message: { text: '/ordered' } }
        });
      }
    }

    const firstMaster = await claimPlatformJob(pool, workerId, ['telegram.master.update']);
    assert.equal(firstMaster.payload.updateId, updateIds.master[0]);
    await completePlatformJob(pool, { jobId: firstMaster.id, workerId });
    await pool.query(
      "UPDATE platform_bot_inbound_updates SET state = 'processed', processed_at = NOW() WHERE bot_identity = 'master' AND update_id = $1",
      [updateIds.master[0]]
    );
    const secondMaster = await claimPlatformJob(pool, workerId, ['telegram.master.update']);
    assert.equal(secondMaster.payload.updateId, updateIds.master[1]);
    await completePlatformJob(pool, { jobId: secondMaster.id, workerId });
    await pool.query(
      "UPDATE platform_bot_inbound_updates SET state = 'processed', processed_at = NOW() WHERE bot_identity = 'master' AND update_id = $1",
      [updateIds.master[1]]
    );

    const firstIntake = await claimPlatformJob(pool, workerId, ['telegram.intake.update']);
    assert.equal(firstIntake.payload.updateId, updateIds.intake[0]);
    await completePlatformJob(pool, { jobId: firstIntake.id, workerId });
    await pool.query(
      "UPDATE platform_bot_inbound_updates SET state = 'processed', processed_at = NOW() WHERE bot_identity = 'intake' AND update_id = $1",
      [updateIds.intake[0]]
    );
    const secondIntake = await claimPlatformJob(pool, workerId, ['telegram.intake.update']);
    assert.equal(secondIntake.payload.updateId, updateIds.intake[1]);
    await completePlatformJob(pool, { jobId: secondIntake.id, workerId });
    await pool.query(
      "UPDATE platform_bot_inbound_updates SET state = 'processed', processed_at = NOW() WHERE bot_identity = 'intake' AND update_id = $1",
      [updateIds.intake[1]]
    );

    await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: deadLetterId, message: { text: '/will-fail' } }
    });
    const key = 'telegram.master.update:' + deadLetterId;
    await pool.query(
      "UPDATE platform_jobs SET max_attempts = 1 WHERE job_type = 'telegram.master.update' AND idempotency_key = $1",
      [key]
    );
    const doomed = await claimPlatformJob(pool, workerId, ['telegram.master.update']);
    assert.equal(doomed.payload.updateId, deadLetterId);
    const dead = await failPlatformJob(pool, {
      jobId: doomed.id,
      workerId,
      error: new Error('integration dead-letter'),
      retryDelaySeconds: 1
    });
    assert.equal(dead.status, 'dead_letter');

    const inboxDead = await pool.query(
      "SELECT state FROM platform_bot_inbound_updates WHERE bot_identity = 'master' AND update_id = $1",
      [deadLetterId]
    );
    assert.equal(inboxDead.rows[0].state, 'dead_letter');

    const duplicateDelivery = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: deadLetterId, message: { text: '/duplicate-delivery' } }
    });
    assert.equal(duplicateDelivery.duplicate, true);

    const requeued = await requeueDeadLetterPlatformBotUpdate(pool, {
      botIdentity: 'master',
      updateId: deadLetterId
    });
    assert.equal(requeued.requeued, true);
    const states = await pool.query(
      `SELECT job.status, inbox.state
       FROM platform_jobs AS job
       JOIN platform_bot_inbound_updates AS inbox
         ON inbox.bot_identity = 'master' AND inbox.update_id = $1
       WHERE job.job_type = 'telegram.master.update' AND job.idempotency_key = $2`,
      [deadLetterId, key]
    );
    assert.deepEqual(states.rows[0], { status: 'queued', state: 'queued' });
    const reclaimed = await claimPlatformJob(pool, workerId, ['telegram.master.update']);
    assert.equal(reclaimed.payload.updateId, deadLetterId);
  } finally {
    await pool.query('DELETE FROM platform_jobs WHERE idempotency_key = ANY($1::text[])', [allKeys]);
    await pool.query(
      'DELETE FROM platform_bot_inbound_updates WHERE (bot_identity = $1 AND update_id = ANY($2::bigint[])) OR (bot_identity = $3 AND update_id = ANY($4::bigint[])) OR (bot_identity = $1 AND update_id = $5)',
      ['master', updateIds.master, 'intake', updateIds.intake, deadLetterId]
    );
    await pool.end();
  }
});


test('platform Telegram update is reclaimed after a worker crashes while the inbox is processing', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is required for the disposable PostgreSQL integration test' : false
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 5
  });
  const updateId = Number(BigInt(Date.now()) * 1000n + 90000n);
  const jobType = 'telegram.master.update';
  const key = 'telegram.master.update:' + updateId;
  const crashedWorker = 'crashed-platform-worker-' + randomUUID();
  const recoveryWorker = 'recovery-platform-worker-' + randomUUID();
  let inboxId;

  try {
    const accepted = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: updateId, message: { text: '/crash-recovery' } }
    });
    inboxId = accepted.id;

    const abandoned = await claimPlatformJob(pool, crashedWorker, [jobType]);
    assert.equal(abandoned.payload.updateId, updateId);

    await pool.query(
      `UPDATE platform_bot_inbound_updates
       SET state = 'processing', attempts = attempts + 1,
           locked_by = $2, locked_at = NOW() - INTERVAL '10 minutes'
       WHERE id = $1`,
      [inboxId, crashedWorker]
    );
    await pool.query(
      "UPDATE platform_jobs SET locked_at = NOW() - INTERVAL '10 minutes' WHERE id = $1",
      [abandoned.id]
    );

    const recovered = await recoverExpiredPlatformJobs(pool, 10, [jobType]);
    assert.ok(recovered.some(row => String(row.id) === String(abandoned.id)));
    const retry = await pool.query(
      'SELECT status FROM platform_jobs WHERE id = $1',
      [abandoned.id]
    );
    assert.equal(retry.rows[0].status, 'retrying');

    const reclaimed = await claimPlatformJob(pool, recoveryWorker, [jobType]);
    assert.equal(reclaimed.payload.updateId, updateId);

    let dispatches = 0;
    const handler = createPlatformBotUpdateHandler({
      pool,
      leaseSeconds: 120,
      runtimes: {
        master: {
          async handleUpdate(update) {
            dispatches += 1;
            assert.equal(update.update_id, updateId);
          }
        }
      }
    });
    const result = await handler(reclaimed, {
      workerId: recoveryWorker,
      leaseSeconds: 120,
      isLeaseLost: () => false
    });
    assert.equal(result.processed, true);
    assert.equal(dispatches, 1);
    await completePlatformJob(pool, { jobId: reclaimed.id, workerId: recoveryWorker });

    const finalState = await pool.query(
      `SELECT inbox.state, job.status
       FROM platform_bot_inbound_updates AS inbox
       JOIN platform_jobs AS job
         ON job.job_type = $1 AND job.idempotency_key = $2
       WHERE inbox.id = $3`,
      [jobType, key, inboxId]
    );
    assert.deepEqual(finalState.rows[0], { state: 'processed', status: 'completed' });
  } finally {
    await pool.query('DELETE FROM platform_jobs WHERE job_type = $1 AND idempotency_key = $2', [jobType, key]);
    if (inboxId) {
      await pool.query('DELETE FROM platform_bot_inbound_updates WHERE id = $1', [inboxId]);
    }
    await pool.end();
  }
});
