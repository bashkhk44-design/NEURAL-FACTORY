'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const databaseUrl = process.env.DATABASE_URL;
test('deployment preflight worker recovers expired leases after restart without consuming other job types', {
  skip: !databaseUrl ? 'DATABASE_URL is required; use only disposable PostgreSQL' : false
}, async () => {
  const { Pool } = require('pg');
  const {
    enqueuePlatformJob,
    claimPlatformJob,
    recoverExpiredPlatformJobs
  } = require('../platform-queue');
  const { createQueueWorker } = require('../queue-worker');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 4,
    connectionTimeoutMillis: 10000
  });
  const suffix = randomUUID();
  let clientId;
  let projectId;
  const jobIds = [];

  try {
    const client = await pool.query(
      'INSERT INTO clients (telegram_user_id) VALUES ($1) RETURNING id',
      [String(800000000 + Math.floor(Math.random() * 100000000))]
    );
    clientId = client.rows[0].id;
    const project = await pool.query(
      'INSERT INTO client_projects (client_id) VALUES ($1) RETURNING id',
      [clientId]
    );
    projectId = project.rows[0].id;

    const expired = await enqueuePlatformJob(pool, {
      jobType: 'deployment.preflight',
      clientId,
      projectId,
      idempotencyKey: 'recovery:preflight:' + suffix,
      maxAttempts: 3,
      payload: { fixture: true }
    });
    const unrelated = await enqueuePlatformJob(pool, {
      jobType: 'telegram.update',
      idempotencyKey: 'recovery:telegram:' + suffix,
      payload: { fixture: true }
    });
    jobIds.push(expired.job.id, unrelated.job.id);

    const abandoned = await claimPlatformJob(pool, 'crashed-preflight-worker-' + suffix, ['deployment.preflight']);
    assert.equal(String(abandoned.id), String(expired.job.id));
    await pool.query(
      "UPDATE platform_jobs SET locked_at = NOW() - INTERVAL '10 minutes' WHERE id = ANY($1::bigint[])",
      [[expired.job.id]]
    );

    const recovered = await recoverExpiredPlatformJobs(pool, 10, ['deployment.preflight']);
    assert.ok(recovered.some(row => String(row.id) === String(expired.job.id)));
    assert.equal(recovered.some(row => String(row.id) === String(unrelated.job.id)), false);

    const states = await pool.query(
      'SELECT id, status, attempts, locked_by FROM platform_jobs WHERE id = ANY($1::bigint[])',
      [[expired.job.id, unrelated.job.id]]
    );
    const recoveredState = states.rows.find(row => String(row.id) === String(expired.job.id));
    const unrelatedState = states.rows.find(row => String(row.id) === String(unrelated.job.id));
    assert.equal(recoveredState.status, 'retrying');
    assert.equal(Number(recoveredState.attempts), 1);
    assert.equal(recoveredState.locked_by, null);
    assert.equal(unrelatedState.status, 'queued');

    let executions = 0;
    const restartedWorker = createQueueWorker({
      pool,
      workerId: 'restarted-preflight-worker-' + suffix,
      handlers: {
        'deployment.preflight': async () => {
          executions += 1;
          return { recoveredAfterRestart: true, executionAllowed: false, deployed: false };
        }
      },
      pollIntervalMs: 100,
      leaseSeconds: 30,
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal(await restartedWorker.processOne(), true);
    assert.equal(await restartedWorker.processOne(), false);
    assert.equal(executions, 1);

    const completed = await pool.query(
      'SELECT status, attempts, payload FROM platform_jobs WHERE id = $1',
      [expired.job.id]
    );
    assert.equal(completed.rows[0].status, 'completed');
    assert.equal(Number(completed.rows[0].attempts), 2);
    assert.equal(completed.rows[0].payload.result.recoveredAfterRestart, true);
    assert.equal(completed.rows[0].payload.result.executionAllowed, false);
    assert.equal(completed.rows[0].payload.result.deployed, false);

    const exhausted = await enqueuePlatformJob(pool, {
      jobType: 'deployment.preflight',
      clientId,
      projectId,
      idempotencyKey: 'recovery:exhausted:' + suffix,
      maxAttempts: 1,
      payload: { fixture: true }
    });
    jobIds.push(exhausted.job.id);
    const finalAttempt = await claimPlatformJob(pool, 'crashed-final-preflight-worker-' + suffix, ['deployment.preflight']);
    assert.equal(String(finalAttempt.id), String(exhausted.job.id));
    await pool.query(
      "UPDATE platform_jobs SET locked_at = NOW() - INTERVAL '10 minutes' WHERE id = $1",
      [exhausted.job.id]
    );
    const exhaustedRecovery = await recoverExpiredPlatformJobs(pool, 10, ['deployment.preflight']);
    assert.ok(exhaustedRecovery.some(row => String(row.id) === String(exhausted.job.id) && row.status === 'dead_letter'));

    const terminal = await pool.query(
      'SELECT status, attempts, locked_by FROM platform_jobs WHERE id = $1',
      [exhausted.job.id]
    );
    assert.equal(terminal.rows[0].status, 'dead_letter');
    assert.equal(Number(terminal.rows[0].attempts), 1);
    assert.equal(terminal.rows[0].locked_by, null);
  } finally {
    if (jobIds.length) {
      await pool.query('DELETE FROM platform_jobs WHERE id = ANY($1::bigint[])', [jobIds]);
    }
    if (projectId) await pool.query('DELETE FROM client_projects WHERE id = $1', [projectId]);
    if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    await pool.end();
  }
});
