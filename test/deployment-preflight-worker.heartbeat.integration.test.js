'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const databaseUrl = process.env.DATABASE_URL;
test('a running deployment preflight renews its PostgreSQL lease before recovery can reclaim it', {
  skip: !databaseUrl ? 'DATABASE_URL is required; use only disposable PostgreSQL' : false
}, async () => {
  const { Pool } = require('pg');
  const { enqueuePlatformJob, recoverExpiredPlatformJobs } = require('../platform-queue');
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
  let jobId;

  try {
    const client = await pool.query(
      'INSERT INTO clients (telegram_user_id) VALUES ($1) RETURNING id',
      [String(700000000 + Math.floor(Math.random() * 100000000))]
    );
    clientId = client.rows[0].id;
    const project = await pool.query(
      'INSERT INTO client_projects (client_id) VALUES ($1) RETURNING id',
      [clientId]
    );
    projectId = project.rows[0].id;

    const queued = await enqueuePlatformJob(pool, {
      jobType: 'deployment.preflight',
      clientId,
      projectId,
      idempotencyKey: 'heartbeat:preflight:' + suffix,
      maxAttempts: 3,
      payload: { fixture: true }
    });
    jobId = queued.job.id;

    const worker = createQueueWorker({
      pool,
      workerId: 'heartbeat-integration-' + suffix,
      handlers: {
        'deployment.preflight': async () => {
          await new Promise(resolve => setTimeout(resolve, 12500));
          return { heartbeatObserved: true, executionAllowed: false, deployed: false };
        }
      },
      leaseSeconds: 10,
      logger: { log() {}, warn() {}, error() {} }
    });

    const processing = worker.processOne();
    await new Promise(resolve => setTimeout(resolve, 11000));

    const recovered = await recoverExpiredPlatformJobs(pool, 10, ['deployment.preflight']);
    assert.equal(recovered.some(row => String(row.id) === String(jobId)), false);

    const active = await pool.query(
      "SELECT status, locked_by, locked_at > NOW() - INTERVAL '10 seconds' AS lease_fresh FROM platform_jobs WHERE id = $1",
      [jobId]
    );
    assert.equal(active.rows[0].status, 'processing');
    assert.equal(active.rows[0].locked_by, 'heartbeat-integration-' + suffix);
    assert.equal(active.rows[0].lease_fresh, true);

    assert.equal(await processing, true);
    const completed = await pool.query(
      "SELECT status, attempts, payload->'result' AS result FROM platform_jobs WHERE id = $1",
      [jobId]
    );
    assert.equal(completed.rows[0].status, 'completed');
    assert.equal(Number(completed.rows[0].attempts), 1);
    assert.equal(completed.rows[0].result.heartbeatObserved, true);
    assert.equal(completed.rows[0].result.executionAllowed, false);
    assert.equal(completed.rows[0].result.deployed, false);
  } finally {
    if (jobId) await pool.query('DELETE FROM platform_jobs WHERE id = $1', [jobId]);
    if (projectId) await pool.query('DELETE FROM client_projects WHERE id = $1', [projectId]);
    if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    await pool.end();
  }
});
