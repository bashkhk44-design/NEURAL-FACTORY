'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableJson,
  sha256,
  computeDeploymentAuthorizationDigest,
  computeExecutionApprovalDigest,
  supportsNodeEngine,
  buildPreflightDockerArgs,
  runDeploymentPreflight
} = require('../deployment-preflight');

const IMAGE = 'node:22-alpine@sha256:' + 'a'.repeat(64);

function makeArtifact() {
  return {
    schemaVersion: 1,
    report: {
      tests: {
        status: 'passed',
        executionStatus: 'completed',
        summary: { tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
        acceptanceTests: [{ acceptanceTestId: 'main', passed: true }]
      }
    },
    bundle: {
      files: [
        {
          path: 'package.json',
          content: JSON.stringify({
            name: 'preflight-fixture',
            version: '1.0.0',
            engines: { node: '>=22 <23' },
            scripts: { start: 'node server.js' }
          })
        },
        {
          path: 'boss-manifest.json',
          content: JSON.stringify({
            version: 1,
            requiredEnv: ['PAYMENT_API_KEY'],
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
}

function fixture() {
  const artifact = makeArtifact();
  const release = {
    id: '41',
    project_id: '7',
    release_version: 3,
    spec_version: 2,
    status: 'approved',
    artifact,
    artifact_sha256: sha256(stableJson(artifact))
  };
  const authorization = {
    id: '9',
    release_id: '41',
    authorized_by: '10001',
    status: 'authorized'
  };
  authorization.authorization_sha256 = computeDeploymentAuthorizationDigest({
    release,
    authorizedBy: authorization.authorized_by
  });
  const target = {
    provider: 'render',
    serviceId: 'boss-bot-staging',
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
    id: '40',
    project_id: '7',
    status: 'approved',
    artifact: rollbackArtifact,
    artifact_sha256: sha256(stableJson(rollbackArtifact))
  };
  return {
    release,
    authorization,
    target,
    executionApproval,
    configuredEnvNames: ['PAYMENT_API_KEY'],
    rollbackRelease
  };
}

function successfulDockerSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: JSON.stringify({ runtimeVersion: 'v22.3.0', healthStatus: 200 }),
      stderr: ''
    };
  };
}

test('Node engine compatibility supports bounded major ranges and rejects unsupported syntax', () => {
  assert.equal(supportsNodeEngine('>=22 <23', 'v22.3.0'), true);
  assert.equal(supportsNodeEngine('^20.0.0', 'v20.10.0'), true);
  assert.equal(supportsNodeEngine('^20.0.0', 'v22.0.0'), false);
  assert.equal(supportsNodeEngine('not-a-range', 'v22.3.0'), false);
});

test('Docker preflight command is pinned, networkless, read-only, and resource bounded', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-preflight-args-'));
  try {
    const args = buildPreflightDockerArgs({
      projectDir: dir,
      image: IMAGE,
      script: 'process.exit(0)'
    });
    for (const flag of [
      '--pull=never', '--network=none', '--read-only', '--memory=256m',
      '--cpus=0.5', '--pids-limit=64', '--user=65532:65532',
      '--cap-drop=ALL', '--security-opt=no-new-privileges'
    ]) assert.ok(args.includes(flag), flag);
    assert.ok(!args.includes('--privileged'));
    assert.ok(!args.includes('--network=host'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('complete preflight performs a real-contract health probe and never authorizes deployment', () => {
  const calls = [];
  const result = runDeploymentPreflight({
    ...fixture(),
    image: IMAGE,
    spawn: successfulDockerSpawn(calls)
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'docker');
  assert.equal(calls[0].options.env.PAYMENT_API_KEY, undefined);
  assert.ok(calls[0].args.includes('--network=none'));
  assert.equal(result.runtimeVersion, 'v22.3.0');
  assert.equal(result.healthStatus, 200);
  assert.equal(result.readiness.readyForManualExecutionReview, true);
  assert.equal(result.readiness.executionAllowed, false);
  assert.equal(result.readiness.deployed, false);
  assert.equal(result.executionAllowed, false);
  assert.equal(result.deployed, false);
});

test('preflight rejects a tampered immutable artifact and does not start Docker', () => {
  const input = fixture();
  input.release.artifact.bundle.files[2].content += '\n// tampered';
  let called = false;
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: () => { called = true; }
  });
  assert.equal(called, false);
  assert.equal(result.checks.find(item => item.name === 'artifact_integrity').passed, false);
  assert.equal(result.readiness.readyForManualExecutionReview, false);
});

test('preflight checks configured secret names without receiving secret values', () => {
  const input = fixture();
  input.configuredEnvNames = [];
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: successfulDockerSpawn([])
  });
  assert.deepEqual(result.missingEnv, ['PAYMENT_API_KEY']);
  assert.equal(result.checks.find(item => item.name === 'secrets_available').passed, false);
  assert.equal(result.readiness.executionAllowed, false);
});

test('preflight fails when the prior approved rollback artifact is missing or corrupt', () => {
  const input = fixture();
  input.rollbackRelease.artifact_sha256 = 'f'.repeat(64);
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: successfulDockerSpawn([])
  });
  assert.equal(result.checks.find(item => item.name === 'rollback_plan').passed, false);
  assert.equal(result.readiness.readyForManualExecutionReview, false);
});

test('preflight rejects a mismatched deployment authorization digest', () => {
  const input = fixture();
  input.authorization.authorization_sha256 = 'f'.repeat(64);
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: successfulDockerSpawn([])
  });
  assert.ok(result.readiness.blockers.includes('deployment_authorization_missing_or_mismatched'));
});

test('preflight rejects an execution approval with a tampered digest', () => {
  const input = fixture();
  input.executionApproval.approvalSha256 = 'f'.repeat(64);
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: successfulDockerSpawn([])
  });
  assert.ok(result.readiness.blockers.includes('separate_execution_approval_missing_or_mismatched'));
});

test('preflight rejects an execution approval bound to a different target', () => {
  const input = fixture();
  input.executionApproval.serviceId = 'another-service';
  input.executionApproval.approvalSha256 = computeExecutionApprovalDigest(input.executionApproval);
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: successfulDockerSpawn([])
  });
  assert.ok(result.readiness.blockers.includes('separate_execution_approval_missing_or_mismatched'));
});

test('preflight rejects an unconfirmed or artifact-mismatched target', () => {
  const input = fixture();
  input.target.confirmed = false;
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: successfulDockerSpawn([])
  });
  assert.equal(result.checks.find(item => item.name === 'target_configured').passed, false);
});

test('preflight rejects an incompatible runtime even when the health endpoint responds', () => {
  const input = fixture();
  input.release.artifact.bundle.files[0].content = JSON.stringify({
    name: 'preflight-fixture',
    version: '1.0.0',
    engines: { node: '>=24 <25' },
    scripts: { start: 'node server.js' }
  });
  input.release.artifact_sha256 = sha256(stableJson(input.release.artifact));
  input.target.artifactSha256 = input.release.artifact_sha256;
  input.executionApproval.artifactSha256 = input.release.artifact_sha256;
  input.executionApproval.approvalSha256 = computeExecutionApprovalDigest(input.executionApproval);
  input.authorization.authorization_sha256 = computeDeploymentAuthorizationDigest({
    release: input.release,
    authorizedBy: input.authorization.authorized_by
  });
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: successfulDockerSpawn([])
  });
  assert.equal(result.checks.find(item => item.name === 'runtime_compatibility').passed, false);
  assert.equal(result.readiness.readyForManualExecutionReview, false);
});

test('preflight fails if the application health endpoint does not return 2xx', () => {
  const result = runDeploymentPreflight({
    ...fixture(),
    image: IMAGE,
    spawn: () => ({
      status: 1,
      stdout: JSON.stringify({ runtimeVersion: 'v22.3.0', healthStatus: 503 }),
      stderr: 'health endpoint unavailable'
    })
  });
  assert.equal(result.healthStatus, 503);
  assert.equal(result.checks.find(item => item.name === 'health_check').passed, false);
});

test('preflight requires a health route and a compatible runtime declaration', () => {
  const input = fixture();
  input.release.artifact.bundle.files[1].content = JSON.stringify({
    version: 1,
    requiredEnv: ['PAYMENT_API_KEY'],
    optionalEnv: [],
    startScript: 'start'
  });
  input.release.artifact_sha256 = sha256(stableJson(input.release.artifact));
  input.target.artifactSha256 = input.release.artifact_sha256;
  input.executionApproval.artifactSha256 = input.release.artifact_sha256;
  input.executionApproval.approvalSha256 = computeExecutionApprovalDigest(input.executionApproval);
  input.authorization.authorization_sha256 = computeDeploymentAuthorizationDigest({
    release: input.release,
    authorizedBy: input.authorization.authorized_by
  });
  let called = false;
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: () => { called = true; }
  });
  assert.equal(called, false);
  assert.equal(result.checks.find(item => item.name === 'health_check').passed, false);
  assert.equal(result.checks.find(item => item.name === 'runtime_compatibility').passed, false);
});

test('preflight refuses to run dependency-bearing apps without a verified runtime tree', () => {
  const input = fixture();
  input.release.artifact.bundle.files[0].content = JSON.stringify({
    name: 'preflight-fixture',
    version: '1.0.0',
    engines: { node: '>=22 <23' },
    scripts: { start: 'node server.js' },
    dependencies: { express: '^5.0.0' }
  });
  input.release.artifact_sha256 = sha256(stableJson(input.release.artifact));
  input.target.artifactSha256 = input.release.artifact_sha256;
  input.executionApproval.artifactSha256 = input.release.artifact_sha256;
  input.executionApproval.approvalSha256 = computeExecutionApprovalDigest(input.executionApproval);
  input.authorization.authorization_sha256 = computeDeploymentAuthorizationDigest({
    release: input.release,
    authorizedBy: input.authorization.authorized_by
  });
  let called = false;
  const result = runDeploymentPreflight({
    ...input,
    image: IMAGE,
    spawn: () => { called = true; }
  });
  assert.equal(called, false);
  assert.equal(result.checks.find(item => item.name === 'health_check').passed, false);
});

test('health preflight command contains placeholders but no secret values', () => {
  const calls = [];
  runDeploymentPreflight({
    ...fixture(),
    image: IMAGE,
    spawn: successfulDockerSpawn(calls)
  });
  const serialized = calls[0].args.join(' ');
  assert.ok(serialized.includes('BOSS_PREFLIGHT_PLACEHOLDER'));
  assert.ok(!serialized.includes('real-secret-value'));
});
