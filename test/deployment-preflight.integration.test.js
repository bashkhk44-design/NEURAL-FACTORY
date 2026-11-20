'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableJson,
  sha256,
  computeDeploymentAuthorizationDigest,
  computeExecutionApprovalDigest,
  runDeploymentPreflight
} = require('../deployment-preflight');

test('deployment preflight starts the artifact and probes its health route in the real isolated Docker sandbox', {
  skip: !process.env.BOSS_SANDBOX_IMAGE
}, () => {
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
        {
          path: 'package.json',
          content: JSON.stringify({
            name: 'boss-preflight-live-smoke',
            version: '1.0.0',
            engines: { node: '>=22 <23' },
            scripts: { start: 'node server.js' }
          })
        },
        {
          path: 'boss-manifest.json',
          content: JSON.stringify({
            version: 1,
            requiredEnv: ['PREFLIGHT_TEST_KEY'],
            optionalEnv: [],
            startScript: 'start',
            healthCheck: '/health'
          })
        },
        {
          path: 'server.js',
          content: [
            "const http = require('node:http');",
            "const server = http.createServer((req, res) => {",
            "  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{\"ok\":true}'); return; }",
            "  res.writeHead(404); res.end();",
            '});',
            "server.listen(Number(process.env.PORT || 41739), '127.0.0.1');"
          ].join('\n')
        }
      ]
    }
  };
  const release = {
    id: '51',
    project_id: '8',
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
  const target = {
    provider: 'render',
    serviceId: 'preflight-staging-fixture',
    environment: 'staging',
    artifactSha256: release.artifact_sha256,
    confirmed: true
  };
  const executionApproval = {
    status: 'approved',
    approvedBy: '10001',
    releaseId: release.id,
    artifactSha256: release.artifact_sha256,
    provider: target.provider,
    serviceId: target.serviceId,
    environment: target.environment
  };
  executionApproval.approvalSha256 = computeExecutionApprovalDigest(executionApproval);
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

  const result = runDeploymentPreflight({
    release,
    authorization,
    target,
    executionApproval,
    configuredEnvNames: ['PREFLIGHT_TEST_KEY'],
    rollbackRelease,
    image: process.env.BOSS_SANDBOX_IMAGE
  });

  assert.equal(result.runtimeVersion.startsWith('v22.'), true);
  assert.equal(result.healthStatus, 200);
  assert.equal(result.checks.every(check => check.passed), true,
    JSON.stringify(result.checks));
  assert.equal(result.readiness.readyForManualExecutionReview, true);
  assert.equal(result.executionAllowed, false);
  assert.equal(result.deployed, false);
});
