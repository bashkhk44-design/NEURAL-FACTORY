'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = Boolean(process.env.DATABASE_URL);
test('isolated deployment worker consumes only its registered job type in real PostgreSQL', {
  skip: !enabled && 'DATABASE_URL is not set; run only against a disposable CI database'
}, async () => {
  const { Pool } = require('pg');
  const { getPostgresSslConfig } = require('../postgres-ssl');
  const { enqueuePlatformJob } = require('../platform-queue');
  const { createQueueWorker } = require('../queue-worker');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: getPostgresSslConfig(),
    max: 2,
    connectionTimeoutMillis: 10000
  });
  let clientId;
  let projectId;
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
    const preflight = await enqueuePlatformJob(pool, {
      jobType: 'deployment.preflight', clientId, projectId,
      idempotencyKey: 'integration:deployment:' + projectId,
      payload: { fixture: true }
    });
    const telegram = await enqueuePlatformJob(pool, {
      jobType: 'telegram.update',
      idempotencyKey: 'integration:telegram:' + projectId,
      payload: { fixture: true }
    });
    assert.equal(preflight.created, true);
    assert.equal(telegram.created, true);
    const worker = createQueueWorker({
      pool,
      workerId: 'integration-deployment-worker-' + projectId,
      handlers: {
        'deployment.preflight': async job => ({
          isolatedPreflightAttempted: true,
          executionAllowed: false,
          deployed: false,
          sourceJobId: String(job.id)
        })
      },
      pollIntervalMs: 100,
      leaseSeconds: 30,
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal(await worker.processOne(), true);
    assert.equal(await worker.processOne(), false);
    const rows = await pool.query(
      'SELECT id, job_type, status, payload, locked_by FROM platform_jobs WHERE id = ANY($1::bigint[]) ORDER BY id',
      [[preflight.job.id, telegram.job.id]]
    );
    const completed = rows.rows.find(row => String(row.id) === String(preflight.job.id));
    const untouched = rows.rows.find(row => String(row.id) === String(telegram.job.id));
    assert.equal(completed.status, 'completed');
    assert.equal(completed.payload.result.isolatedPreflightAttempted, true);
    assert.equal(completed.payload.result.executionAllowed, false);
    assert.equal(completed.payload.result.deployed, false);
    assert.equal(untouched.status, 'queued');
    assert.equal(untouched.locked_by, null);
  } finally {
    if (projectId) {
      await pool.query('DELETE FROM platform_jobs WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM client_projects WHERE id = $1', [projectId]);
    }
    if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    await pool.end();
  }
});
