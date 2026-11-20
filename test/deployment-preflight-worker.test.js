'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableJson,
  sha256,
  computeDeploymentAuthorizationDigest
} = require('../deployment-preflight');
const {
  createDeploymentPreflightHandler,
  main
} = require('../deployment-preflight-worker');

function fixture() {
  const artifact = {
    schemaVersion: 1,
    report: {
      tests: {
        status: 'passed',
        executionStatus: 'completed',
        summary: { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
        acceptanceTests: [{ acceptanceTestId: 'health', passed: true }]
      }
    },
    bundle: {
      files: [
        { path: 'package.json', content: '{"name":"worker-fixture","version":"1.0.0","engines":{"node":">=22 <23"},"scripts":{"start":"node server.js"}}' },
        { path: 'boss-manifest.json', content: '{"version":1,"requiredEnv":["PAYMENT_API_KEY"],"optionalEnv":[],"startScript":"start","healthCheck":"/health"}' },
        { path: 'server.js', content: '/* test fixture */' }
      ]
    }
  };
  const release = {
    id: '51',
    project_id: '8',
    project_name: 'Worker fixture',
    release_version: 2,
    spec_version: 1,
    status: 'approved',
    artifact,
    artifact_sha256: sha256(stableJson(artifact))
  };
  const authorization = {
    id: '12',
    release_id: '51',
    authorized_by: '10001',
    status: 'authorized'
  };
  authorization.authorization_sha256 = computeDeploymentAuthorizationDigest({
    release,
    authorizedBy: authorization.authorized_by
  });
  const envNames = ['PAYMENT_API_KEY'];
  const envNamesSha256 = sha256(stableJson(envNames));
  const rollbackArtifact = {
    schemaVersion: 1,
    report: { previous: true },
    bundle: { files: [{ path: 'package.json', content: '{"name":"previous","version":"1.0.0"}' }] }
  };
  const rollbackRelease = {
    id: '50',
    project_id: '8',
    status: 'approved',
    artifact: rollbackArtifact,
    artifact_sha256: sha256(stableJson(rollbackArtifact))
  };
  const job = {
    id: '900',
    job_type: 'deployment.preflight',
    project_id: '8',
    payload: {
      releaseId: '51',
      projectId: '8',
      artifactSha256: release.artifact_sha256,
      envNamesSha256,
      requestedBy: '10001'
    }
  };
  return { release, authorization, envNames, envNamesSha256, rollbackRelease, job };
}

function createPool(data) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM project_release_candidates r')) {
        return { rowCount: 1, rows: [data.release] };
      }
      if (sql.includes('FROM project_deployment_authorizations')) {
        return { rowCount: data.authorization ? 1 : 0, rows: data.authorization ? [data.authorization] : [] };
      }
      if (sql.includes('SELECT env_name FROM project_secrets')) {
        return { rowCount: data.envNames.length, rows: data.envNames.map(env_name => ({ env_name })) };
      }
      if (sql.includes('FROM project_release_candidates') && sql.includes('id <> $2')) {
        return { rowCount: data.rollbackRelease ? 1 : 0, rows: data.rollbackRelease ? [data.rollbackRelease] : [] };
      }
      throw new Error('Unexpected query: ' + sql.slice(0, 100));
    }
  };
  return pool;
}

test('dedicated handler verifies release, authorization, actor and env-name digest before isolated preflight', async () => {
  const data = fixture();
  const pool = createPool(data);
  let input;
  const handler = createDeploymentPreflightHandler({
    pool,
    image: 'node:22-alpine@sha256:' + 'a'.repeat(64),
    preflight(args) {
      input = args;
      return {
        checks: [{ name: 'health_check', passed: true, evidence: 'HTTP 200' }],
        missingEnv: [],
        runtimeVersion: 'v22.4.0',
        healthStatus: 200,
        readiness: {
          blockers: ['deployment_target_missing_or_unconfirmed'],
          readyForManualExecutionReview: false,
          readinessSha256: 'b'.repeat(64)
        },
        executionAllowed: false,
        deployed: false
      };
    }
  });

  const result = await handler(data.job);
  assert.equal(input.release.id, '51');
  assert.equal(input.authorization.id, '12');
  assert.equal(input.target, null);
  assert.equal(input.executionApproval, null);
  assert.deepEqual(input.configuredEnvNames, ['PAYMENT_API_KEY']);
  assert.equal(input.rollbackRelease.id, '50');
  const rollbackQuery = pool.calls.find(call => call.sql.includes('release_version < $3'));
  assert.deepEqual(rollbackQuery.params, ['8', '51', 2]);
  assert.equal(result.isolatedPreflightAttempted, true);
  assert.equal(result.isolatedPreflightExecuted, true);
  assert.equal(result.dockerHealthProbePassed, true);
  assert.equal(result.healthStatus, 200);
  assert.equal(result.readyForManualExecutionReview, false);
  assert.equal(result.executionAllowed, false);
  assert.equal(result.deployed, false);

  const secretQuery = pool.calls.find(call => call.sql.includes('project_secrets'));
  assert.match(secretQuery.sql, /SELECT env_name/);
  assert.doesNotMatch(secretQuery.sql, /secret_ciphertext|secret_iv|secret_auth_tag|SELECT \*/);
});

test('handler rejects tampered artifact and does not start Docker preflight', async () => {
  const data = fixture();
  data.release.artifact.bundle.files[2].content += '\n// tampered';
  const pool = createPool(data);
  let called = false;
  const handler = createDeploymentPreflightHandler({
    pool,
    preflight() { called = true; throw new Error('must not run'); }
  });
  await assert.rejects(handler(data.job), /artifact digest is invalid/);
  assert.equal(called, false);
});

test('handler rejects missing or mismatched authorization before Docker preflight', async () => {
  const data = fixture();
  data.authorization = null;
  const pool = createPool(data);
  let called = false;
  const handler = createDeploymentPreflightHandler({
    pool,
    preflight() { called = true; }
  });
  await assert.rejects(handler(data.job), /valid immutable deployment authorization/);
  assert.equal(called, false);
});

test('handler rejects a job bound to another project or artifact', async () => {
  const data = fixture();
  data.job.payload.projectId = '99';
  const pool = createPool(data);
  const handler = createDeploymentPreflightHandler({
    pool,
    preflight() { assert.fail('preflight must not run'); }
  });
  await assert.rejects(handler(data.job), /no longer matches the approved release/);
});

test('handler blocks stale environment-name configuration without running Docker', async () => {
  const data = fixture();
  data.envNames = ['PAYMENT_API_KEY', 'NEW_REQUIRED_NAME'];
  const pool = createPool(data);
  let called = false;
  const handler = createDeploymentPreflightHandler({
    pool,
    preflight() { called = true; }
  });
  const result = await handler(data.job);
  assert.equal(called, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.isolatedPreflightAttempted, false);
  assert.equal(result.isolatedPreflightExecuted, false);
  assert.equal(result.executionAllowed, false);
  assert.equal(result.deployed, false);
});

test('worker startup is disabled unless explicitly enabled', async () => {
  await assert.rejects(
    main({ env: {}, PoolClass: class { constructor() { assert.fail('pool must not be created'); } } }),
    /DEPLOYMENT_PREFLIGHT_WORKER_ENABLED=true/
  );
});

test('worker startup requires a pinned immutable sandbox image', async () => {
  await assert.rejects(
    main({
      env: {
        DEPLOYMENT_PREFLIGHT_WORKER_ENABLED: 'true',
        DATABASE_URL: 'postgresql://test',
        BOSS_SANDBOX_IMAGE: 'node:22-alpine'
      },
      PoolClass: class { constructor() { assert.fail('pool must not be created'); } }
    }),
    /immutable image reference/
  );
});
