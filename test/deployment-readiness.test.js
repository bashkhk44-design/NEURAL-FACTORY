'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_DEPLOYMENT_CHECKS,
  evaluateDeploymentReadiness
} = require('../deployment-readiness');

function fixture() {
  const release = {
    id: '41',
    status: 'approved',
    artifact_sha256: 'a'.repeat(64),
    artifact: {
      report: {
        tests: {
          status: 'passed',
          executionStatus: 'completed',
          summary: {
            tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, cancelled: 0
          },
          acceptanceTests: [{ id: 'A1', name: 'basic flow', passed: true }, { id: 'A2', name: 'recovery flow', passed: true }]
        }
      }
    }
  };
  const authorization = {
    id: '9',
    release_id: '41',
    authorized_by: '10001',
    status: 'authorized',
    authorization_sha256: 'b'.repeat(64)
  };
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
    approvalSha256: 'c'.repeat(64),
    releaseId: '41',
    artifactSha256: release.artifact_sha256,
    provider: target.provider,
    serviceId: target.serviceId,
    environment: target.environment
  };
  const checks = REQUIRED_DEPLOYMENT_CHECKS.map(name => ({
    name, passed: true, evidence: 'Verified by isolated preflight fixture.'
  }));
  return { release, authorization, target, executionApproval, checks };
}

test('readiness requires all release, authorization, target and execution approvals', () => {
  const result = evaluateDeploymentReadiness(fixture());
  assert.equal(result.readyForManualExecutionReview, true);
  assert.equal(result.executionAllowed, false);
  assert.equal(result.deployed, false);
  assert.deepEqual(result.blockers, []);
  assert.match(result.readinessSha256, /^[a-f0-9]{64}$/);
});

test('readiness fails closed when the release is not approved', () => {
  const input = fixture();
  input.release.status = 'awaiting_manager';
  const result = evaluateDeploymentReadiness(input);
  assert.equal(result.readyForManualExecutionReview, false);
  assert.ok(result.blockers.includes('release_not_approved_or_invalid'));
});

test('readiness rejects an authorization for a different release', () => {
  const input = fixture();
  input.authorization.release_id = '42';
  const result = evaluateDeploymentReadiness(input);
  assert.ok(result.blockers.includes('deployment_authorization_missing_or_mismatched'));
});

test('readiness rejects incomplete, skipped or failed acceptance evidence', () => {
  const input = fixture();
  input.release.artifact.report.tests.summary.skipped = 1;
  const result = evaluateDeploymentReadiness(input);
  assert.ok(result.blockers.includes('release_test_evidence_incomplete'));
});

test('readiness rejects non-finite or unsafe test counts', () => {
  const input = fixture();
  input.release.artifact.report.tests.summary.tests = Number.POSITIVE_INFINITY;
  input.release.artifact.report.tests.summary.passed = Number.POSITIVE_INFINITY;
  const result = evaluateDeploymentReadiness(input);
  assert.ok(result.blockers.includes('release_test_evidence_incomplete'));
});

test('readiness requires an explicitly confirmed target matching the artifact', () => {
  const input = fixture();
  input.target.confirmed = false;
  const result = evaluateDeploymentReadiness(input);
  assert.ok(result.blockers.includes('deployment_target_missing_or_unconfirmed'));
});

test('readiness requires separate approval for the exact target and environment', () => {
  const input = fixture();
  input.executionApproval.environment = 'production';
  const result = evaluateDeploymentReadiness(input);
  assert.ok(result.blockers.includes('separate_execution_approval_missing_or_mismatched'));
});

test('readiness requires every named preflight check with evidence', () => {
  const input = fixture();
  input.checks = input.checks.filter(item => item.name !== 'rollback_plan');
  const result = evaluateDeploymentReadiness(input);
  assert.ok(result.blockers.includes('deployment_check_failed_or_missing:rollback_plan'));
});

test('readiness rejects duplicate check names', () => {
  const input = fixture();
  input.checks.push({ ...input.checks[0] });
  const result = evaluateDeploymentReadiness(input);
  assert.ok(result.blockers.includes('deployment_checks_invalid_or_duplicated'));
});

test('readiness fingerprint changes when the target changes', () => {
  const input = fixture();
  const before = evaluateDeploymentReadiness(input);
  input.target.serviceId = 'different-service';
  input.executionApproval.serviceId = 'different-service';
  const after = evaluateDeploymentReadiness(input);
  assert.notEqual(before.readinessSha256, after.readinessSha256);
});

test('readiness fingerprint binds approval identities and test evidence', () => {
  const input = fixture();
  const before = evaluateDeploymentReadiness(input);
  input.executionApproval.approvedBy = '10002';
  input.authorization.authorized_by = '10002';
  input.release.artifact.report.tests.summary.tests = 3;
  input.release.artifact.report.tests.summary.passed = 3;
  input.release.artifact.report.tests.acceptanceTests.push({
    id: 'A3', name: 'new acceptance flow', passed: true
  });
  const after = evaluateDeploymentReadiness(input);
  assert.notEqual(before.readinessSha256, after.readinessSha256);
});

test('readiness never authorizes or performs deployment', () => {
  const result = evaluateDeploymentReadiness(fixture());
  assert.equal(result.executionAllowed, false);
  assert.equal(result.deployed, false);
});
