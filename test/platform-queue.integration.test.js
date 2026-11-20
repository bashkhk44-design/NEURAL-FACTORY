'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const databaseUrl = process.env.DATABASE_URL;
const integrationTest = test('PostgreSQL queue integration: idempotency, claims, retry, lease recovery, and Telegram deduplication', {
  skip: !databaseUrl ? 'DATABASE_URL is required for the disposable PostgreSQL integration test' : false
}, async () => {
  const { Pool } = require('pg');
  const {
    enqueuePlatformJob,
    claimPlatformJob,
    completePlatformJob,
    failPlatformJob,
    recoverExpiredPlatformJobs,
    enqueueTelegramUpdate
  } = require('../platform-queue');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 20
  });
  const suffix = randomUUID();
  const keys = [`ci-success:${suffix}`, `ci-fail:${suffix}`, `ci-lease:${suffix}`];
  let botId;

  try {
    const bot = await pool.query(
      "INSERT INTO telegram_bots (name, username, active) VALUES ($1, $2, FALSE) RETURNING id",
      [`queue-ci-${suffix}`, `queue_ci_${suffix.replace(/-/g, '').slice(0, 20)}`]
    );
    botId = bot.rows[0].id;

    const first = await enqueuePlatformJob(pool, {
      jobType: 'ci.queue.success',
      botId,
      idempotencyKey: keys[0],
      payload: { check: 'success' }
    });
    const duplicate = await enqueuePlatformJob(pool, {
      jobType: 'ci.queue.success',
      botId,
      idempotencyKey: keys[0],
      payload: { check: 'duplicate' }
    });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);

    const claimed = await claimPlatformJob(pool, `worker-a-${suffix}`, ['ci.queue.success']);
    assert.equal(String(claimed.id), String(first.job.id));
    const competingClaim = await claimPlatformJob(pool, `worker-b-${suffix}`, ['ci.queue.success']);
    assert.equal(competingClaim, null, 'a claimed job must not be claimed a second time');
    await completePlatformJob(pool, {
      jobId: claimed.id,
      workerId: `worker-a-${suffix}`,
      result: { verified: true }
    });

    await enqueuePlatformJob(pool, {
      jobType: 'ci.queue.fail',
      botId,
      idempotencyKey: keys[1],
      maxAttempts: 1
    });
    const failing = await claimPlatformJob(pool, `worker-fail-${suffix}`, ['ci.queue.fail']);
    const failed = await failPlatformJob(pool, {
      jobId: failing.id,
      workerId: `worker-fail-${suffix}`,
      error: new Error('expected integration failure'),
      retryDelaySeconds: 1
    });
    assert.equal(failed.status, 'dead_letter');

    await enqueuePlatformJob(pool, {
      jobType: 'ci.queue.lease',
      botId,
      idempotencyKey: keys[2],
      maxAttempts: 2
    });
    const leased = await claimPlatformJob(pool, `worker-lease-${suffix}`, ['ci.queue.lease']);
    await pool.query(
      "UPDATE platform_jobs SET locked_at = NOW() - INTERVAL '10 minutes' WHERE id = $1",
      [leased.id]
    );
    const recovered = await recoverExpiredPlatformJobs(pool, 10, ['ci.queue.lease']);
    assert.ok(recovered.some(row => String(row.id) === String(leased.id)));
    const reclaimed = await claimPlatformJob(pool, `worker-reclaim-${suffix}`, ['ci.queue.lease']);
    assert.equal(String(reclaimed.id), String(leased.id));
    const dead = await failPlatformJob(pool, {
      jobId: reclaimed.id,
      workerId: `worker-reclaim-${suffix}`,
      error: new Error('second attempt failed'),
      retryDelaySeconds: 1
    });
    assert.equal(dead.status, 'dead_letter');

    const update = { update_id: 700000001, message: { text: '/start' } };
    const accepted = await enqueueTelegramUpdate(pool, { botId, update });
    const repeated = await enqueueTelegramUpdate(pool, { botId, update });
    assert.equal(accepted.duplicate, false);
    assert.equal(repeated.duplicate, true);
    // The update was only used to verify durable enqueue/deduplication above.
    await pool.query("DELETE FROM platform_jobs WHERE bot_id = $1 AND job_type = 'telegram.update'", [botId]);

    // Synthetic queue-only concurrency check; this does not contact Telegram.
    for (const workerCount of [5, 10, 25, 50, 100]) {
      const phase = `ci-load:${suffix}:${workerCount}`;
      const phaseJobType = `ci.queue.load.${suffix}.${workerCount}`;
      const totalJobs = workerCount * 3;
      for (let index = 0; index < totalJobs; index += 1) {
        await enqueuePlatformJob(pool, {
          jobType: phaseJobType,
          botId,
          idempotencyKey: `${phase}:${index}`,
          payload: { phase, index }
        });
      }

      const claimedIds = new Set();
      await Promise.all(Array.from({ length: workerCount }, async (_, workerIndex) => {
        const workerId = `${phase}:worker:${workerIndex}`;
        while (true) {
          const job = await claimPlatformJob(pool, workerId, [phaseJobType]);
          if (!job) break;
          const jobId = String(job.id);
          assert.equal(claimedIds.has(jobId), false, `job ${jobId} claimed more than once`);
          claimedIds.add(jobId);
          await completePlatformJob(pool, {
            jobId: job.id,
            workerId,
            result: { phase, workerIndex }
          });
        }
      }));
      assert.equal(claimedIds.size, totalJobs, `all jobs should be completed at ${workerCount} workers`);
    }
  } finally {
    if (botId) {
      await pool.query('DELETE FROM platform_jobs WHERE bot_id = $1', [botId]);
      await pool.query('DELETE FROM platform_jobs WHERE idempotency_key = ANY($1::text[])', [keys]);
      await pool.query('DELETE FROM bot_inbound_updates WHERE bot_id = $1', [botId]);
      await pool.query('DELETE FROM telegram_bots WHERE id = $1', [botId]);
    }
    await pool.end();
  }
});
