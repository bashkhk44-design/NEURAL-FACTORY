'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const { getPostgresSslConfig } = require('./postgres-ssl');
const { createQueueWorker } = require('./queue-worker');
const {
  stableJson,
  sha256,
  computeDeploymentAuthorizationDigest,
  runDeploymentPreflight
} = require('./deployment-preflight');
const { validateSandboxImage } = require('./project-sandbox');

function createDeploymentPreflightHandler({
  pool,
  image = process.env.BOSS_SANDBOX_IMAGE,
  preflight = runDeploymentPreflight,
  spawn
}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('PostgreSQL pool is required.');
  }
  if (typeof preflight !== 'function') {
    throw new TypeError('A deployment preflight runner is required.');
  }

  return async function handleDeploymentPreflight(job) {
    if (!job || job.job_type !== 'deployment.preflight' ||
        !job.payload || typeof job.payload !== 'object') {
      throw new Error('Invalid deployment preflight job.');
    }

    const payload = job.payload;
    if (!/^\d+$/.test(String(payload.releaseId || '')) ||
        !/^\d+$/.test(String(payload.projectId || '')) ||
        !/^\d+$/.test(String(payload.requestedBy || '')) ||
        !/^[a-f0-9]{64}$/.test(String(payload.artifactSha256 || '')) ||
        !/^[a-f0-9]{64}$/.test(String(payload.envNamesSha256 || ''))) {
      throw new Error('Deployment preflight job payload is incomplete or invalid.');
    }

    const found = await pool.query(`
      SELECT r.*, p.name AS project_name
      FROM project_release_candidates r
      JOIN client_projects p ON p.id = r.project_id
      WHERE r.id = $1
      LIMIT 1
    `, [payload.releaseId]);
    if (!found.rowCount) throw new Error('The requested release no longer exists.');

    const release = found.rows[0];
    if (String(release.project_id) !== String(payload.projectId) ||
        String(job.project_id) !== String(payload.projectId) ||
        release.status !== 'approved' ||
        release.artifact_sha256 !== payload.artifactSha256) {
      throw new Error('The queued preflight no longer matches the approved release.');
    }
    if (!release.artifact ||
        sha256(stableJson(release.artifact)) !== release.artifact_sha256) {
      throw new Error('The immutable release artifact digest is invalid.');
    }

    const authorizationResult = await pool.query(`
      SELECT id, release_id, authorized_by, status, authorization_sha256, created_at
      FROM project_deployment_authorizations
      WHERE release_id = $1
      LIMIT 1
    `, [release.id]);
    const authorization = authorizationResult.rows[0] || null;
    if (!authorization ||
        String(authorization.release_id) !== String(release.id) ||
        authorization.status !== 'authorized' ||
        authorization.authorization_sha256 !== computeDeploymentAuthorizationDigest({
          release,
          authorizedBy: authorization.authorized_by
        })) {
      throw new Error('A valid immutable deployment authorization is required before Docker preflight.');
    }
    if (String(authorization.authorized_by) !== String(payload.requestedBy)) {
      throw new Error('The preflight requester does not match the manager who authorized this release.');
    }

    // Only environment variable names are selected. Ciphertext, IV, auth tags,
    // and decrypted secret values are never loaded by this worker.
    const envResult = await pool.query(
      'SELECT env_name FROM project_secrets WHERE project_id = $1 ORDER BY env_name',
      [release.project_id]
    );
    const configuredEnvNames = envResult.rows.map(row => String(row.env_name)).sort();
    if (sha256(stableJson(configuredEnvNames)) !== payload.envNamesSha256) {
      return {
        status: 'blocked',
        isolatedPreflightAttempted: false,
        isolatedPreflightExecuted: false,
        releaseId: String(release.id),
        artifactSha256: release.artifact_sha256,
        checks: [],
        missingEnv: [],
        blockers: ['project_environment_names_changed_after_the_preflight_was_queued'],
        readyForManualExecutionReview: false,
        executionAllowed: false,
        deployed: false
      };
    }

    const rollbackResult = await pool.query(`
      SELECT id, project_id, status, artifact, artifact_sha256
      FROM project_release_candidates
      WHERE project_id = $1
        AND id <> $2
        AND release_version < $3
        AND status = 'approved'
      ORDER BY release_version DESC, id DESC
      LIMIT 1
    `, [release.project_id, release.id, release.release_version]);
    const rollbackRelease = rollbackResult.rows[0] || null;

    const result = await preflight({
      release,
      authorization,
      target: null,
      executionApproval: null,
      configuredEnvNames,
      rollbackRelease,
      image,
      ...(spawn ? { spawn } : {})
    });

    return {
      status: 'completed',
      isolatedPreflightAttempted: true,
      isolatedPreflightExecuted: Boolean(result.runtimeVersion),
      dockerHealthProbePassed: result.checks.some(check => check.name === 'health_check' && check.passed === true),
      releaseId: String(release.id),
      artifactSha256: release.artifact_sha256,
      checks: result.checks,
      missingEnv: result.missingEnv,
      runtimeVersion: result.runtimeVersion,
      healthStatus: result.healthStatus,
      blockers: result.readiness.blockers,
      readyForManualExecutionReview: result.readiness.readyForManualExecutionReview,
      readinessSha256: result.readiness.readinessSha256,
      executionAllowed: false,
      deployed: false
    };
  };
}

async function main({
  env = process.env,
  PoolClass = Pool,
  workerFactory = createQueueWorker,
  logger = console
} = {}) {
  if (env.DEPLOYMENT_PREFLIGHT_WORKER_ENABLED !== 'true') {
    throw new Error('Set DEPLOYMENT_PREFLIGHT_WORKER_ENABLED=true to start this isolated worker.');
  }
  const databaseUrl = require('./database-config').getDatabaseUrl(env);
  validateSandboxImage(env.BOSS_SANDBOX_IMAGE);

  const pool = new PoolClass({
    connectionString: databaseUrl,
    ssl: getPostgresSslConfig(env),
    max: Number(env.DEPLOYMENT_PREFLIGHT_DB_POOL_MAX || 2),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  let worker;
  let shuttingDown = false;
  try {
    await pool.query('SELECT 1');
    worker = workerFactory({
      pool,
      handlers: {
        'deployment.preflight': createDeploymentPreflightHandler({
          pool,
          image: env.BOSS_SANDBOX_IMAGE
        })
      },
      pollIntervalMs: Number(env.DEPLOYMENT_PREFLIGHT_POLL_INTERVAL_MS || 1500),
      leaseSeconds: Number(env.DEPLOYMENT_PREFLIGHT_LEASE_SECONDS || 90),
      logger
    });

    const shutdown = async signal => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.log('Deployment preflight worker stopping:', signal);
      await worker.stop();
      await pool.end();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
      logger.error('Deployment preflight worker shutdown failed:', error.message);
      process.exitCode = 1;
    }));
    process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
      logger.error('Deployment preflight worker shutdown failed:', error.message);
      process.exitCode = 1;
    }));

    logger.log('BOSS isolated deployment preflight worker started.');
    await worker.start();
  } catch (error) {
    if (worker) {
      try { await worker.stop(); } catch (_) {}
    }
    await pool.end();
    throw error;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('DEPLOYMENT PREFLIGHT WORKER STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createDeploymentPreflightHandler,
  main
};
