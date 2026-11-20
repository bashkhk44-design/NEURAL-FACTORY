'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  enqueuePlatformBotUpdate,
  claimPlatformJob,
  completePlatformJob
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
