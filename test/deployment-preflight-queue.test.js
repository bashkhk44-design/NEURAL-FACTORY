'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableJson,
  sha256,
  computeDeploymentAuthorizationDigest
} = require('../deployment-preflight');
const {
  enqueueDeploymentPreflight,
  getLatestDeploymentPreflightJob,
  formatDeploymentPreflightJob
} = require('../deployment-preflight-queue');

function fixture() {
  const artifact = { schemaVersion: 1, bundle: { files: [{ path: 'package.json', content: '{}' }] } };
  const release = {
    id: '7', project_id: '3', release_version: 2, spec_version: 1,
    status: 'approved', artifact,
    artifact_sha256: sha256(stableJson(artifact))
  };
  const authorization = {
    id: '4', release_id: '7', authorized_by: '10001', status: 'authorized'
  };
  authorization.authorization_sha256 = computeDeploymentAuthorizationDigest({
    release, authorizedBy: authorization.authorized_by
  });
  return { release, authorization };
}

test('enqueue binds a durable preflight job to approved release, actor, owner and env-name digest', async () => {
  const { release, authorization } = fixture();
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM platform_jobs') && sql.includes("status IN ('queued', 'processing', 'retrying')")) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT client_id')) return { rowCount: 1, rows: [{ client_id: '2' }] };
      if (sql.includes('SELECT env_name')) return { rowCount: 1, rows: [{ env_name: 'PAYMENT_API_KEY' }] };
      if (sql.includes('INSERT INTO platform_jobs')) {
        return {
          rowCount: 1,
          rows: [{
            id: '99', status: 'queued', attempts: 0, max_attempts: 3,
            payload: JSON.parse(params[5])
          }]
        };
      }
      throw new Error('Unexpected query');
    }
  };

  const result = await enqueueDeploymentPreflight({
    pool, release, authorization, requestedBy: '10001'
  });
  assert.equal(result.created, true);
  assert.equal(result.job.id, '99');
  const insertCall = calls.find(call => call.sql.includes('INSERT INTO platform_jobs'));
  assert.equal(insertCall.params[0], 'deployment.preflight');
  assert.equal(insertCall.params[1], '2');
  assert.equal(insertCall.params[2], '3');
  assert.equal(insertCall.params[6], 10);
  assert.equal(insertCall.params[7], 3);
  assert.equal(result.job.payload.releaseId, '7');
  assert.equal(result.job.payload.artifactSha256, release.artifact_sha256);
  assert.equal(result.job.payload.requestedBy, '10001');
  assert.equal(result.job.payload.envNamesSha256, result.envNamesSha256);
});

test('enqueue refuses unapproved, tampered, unauthorized, or different-actor requests', async () => {
  const { release, authorization } = fixture();
  const pool = { async query() { assert.fail('validation must happen before database access'); } };
  await assert.rejects(
    enqueueDeploymentPreflight({ pool, release: { ...release, status: 'awaiting_manager' }, authorization, requestedBy: '10001' }),
    /approved release/
  );
  await assert.rejects(
    enqueueDeploymentPreflight({
      pool,
      release: { ...release, artifact: { changed: true } },
      authorization,
      requestedBy: '10001'
    }),
    /digest does not match/
  );
  await assert.rejects(
    enqueueDeploymentPreflight({ pool, release, authorization: null, requestedBy: '10001' }),
    /valid, matching deployment authorization/
  );
  await assert.rejects(
    enqueueDeploymentPreflight({ pool, release, authorization, requestedBy: '20002' }),
    /Only the manager/
  );
});

test('latest job query is scoped to release and project', async () => {
  let call;
  const pool = {
    async query(sql, params) {
      call = { sql, params };
      return { rowCount: 1, rows: [{ id: '99', status: 'queued' }] };
    }
  };
  const result = await getLatestDeploymentPreflightJob({ pool, releaseId: '7', projectId: '3' });
  assert.equal(result.id, '99');
  assert.match(call.sql, /job_type = 'deployment\.preflight'/);
  assert.deepEqual(call.params, ['3', '7']);
});

test('formatted preflight status always says execution and deployment are denied', () => {
  const message = formatDeploymentPreflightJob({
    id: '99', status: 'completed', attempts: 1, max_attempts: 3,
    result: {
      isolatedPreflightAttempted: true,
      isolatedPreflightExecuted: true,
      dockerHealthProbePassed: true,
      runtimeVersion: 'v22.4.0',
      healthStatus: 200,
      checks: [{ name: 'health_check', passed: true, evidence: 'HTTP 200' }],
      missingEnv: [],
      blockers: ['deployment_target_missing_or_unconfirmed'],
      readyForManualExecutionReview: false
    }
  }, { id: '7', release_version: 2 });
  assert.match(message, /تشغيل الحاوية مؤكد: نعم/);
  assert.match(message, /بيانات وجهة النشر غير محددة أو غير مؤكدة/);
  assert.match(message, /السماح بالتنفيذ: ❌ لا/);
  assert.match(message, /تم النشر: ❌ لا/);
});
