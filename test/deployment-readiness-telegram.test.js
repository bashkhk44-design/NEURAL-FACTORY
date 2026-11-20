'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableJson,
  sha256,
  computeDeploymentAuthorizationDigest
} = require('../deployment-preflight');
const {
  reviewDeploymentReadiness,
  formatDeploymentReadinessReview
} = require('../deployment-readiness-telegram');

function fixture() {
  const artifact = {
    schemaVersion: 1,
    report: {
      tests: {
        status: 'passed',
        executionStatus: 'completed',
        summary: { tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
        acceptanceTests: [{ id: 'main', name: 'main flow', passed: true }]
      }
    },
    bundle: { files: [{ path: 'package.json', content: '{"name":"fixture"}' }] }
  };
  const release = {
    id: '12',
    project_id: '4',
    project_name: 'Test project',
    release_version: 3,
    spec_version: 2,
    status: 'approved',
    artifact,
    artifact_sha256: sha256(stableJson(artifact))
  };
  const authorization = {
    id: '8',
    release_id: release.id,
    authorized_by: '10001',
    status: 'authorized'
  };
  authorization.authorization_sha256 = computeDeploymentAuthorizationDigest({
    release,
    authorizedBy: authorization.authorized_by
  });
  return { release, authorization };
}

test('Telegram readiness review verifies immutable artifact and deployment authorization digests', () => {
  const { release, authorization } = fixture();
  const review = reviewDeploymentReadiness({ release, authorization });
  assert.equal(review.artifactDigestValid, true);
  assert.equal(review.authorizationDigestValid, true);
  assert.equal(review.isolatedPreflightExecuted, false);
  assert.equal(review.executionAllowed, false);
  assert.equal(review.deployed, false);
  assert.equal(review.readiness.readyForManualExecutionReview, false);
  assert.ok(review.readiness.blockers.includes('deployment_target_missing_or_unconfirmed'));
  assert.ok(review.readiness.blockers.includes('separate_execution_approval_missing_or_mismatched'));
  for (const name of [
    'artifact_integrity',
    'target_configured',
    'runtime_compatibility',
    'secrets_available',
    'rollback_plan',
    'health_check'
  ]) {
    assert.ok(review.readiness.blockers.includes('deployment_check_failed_or_missing:' + name));
  }
});

test('Telegram readiness review fails closed for a changed artifact or mismatched authorization', () => {
  const { release, authorization } = fixture();
  const changedRelease = {
    ...release,
    artifact: { ...release.artifact, changed: true }
  };
  const review = reviewDeploymentReadiness({
    release: changedRelease,
    authorization
  });
  assert.equal(review.artifactDigestValid, false);
  // The authorization still binds the originally recorded digest; the artifact bytes no longer match it.
  assert.equal(review.authorizationDigestValid, true);
  assert.ok(review.readiness.blockers.includes('release_not_approved_or_invalid'));
  assert.equal(review.executionAllowed, false);
  assert.equal(review.deployed, false);

  const mismatchedAuthorization = {
    ...authorization,
    authorization_sha256: 'b'.repeat(64)
  };
  const authorizationReview = reviewDeploymentReadiness({
    release,
    authorization: mismatchedAuthorization
  });
  assert.equal(authorizationReview.artifactDigestValid, true);
  assert.equal(authorizationReview.authorizationDigestValid, false);
  assert.ok(authorizationReview.readiness.blockers.includes('deployment_authorization_missing_or_mismatched'));
});

test('Telegram readiness review message is explicit that isolated preflight and deployment did not run', () => {
  const { release, authorization } = fixture();
  const review = reviewDeploymentReadiness({ release, authorization });
  const message = formatDeploymentReadinessReview({ release, review });
  assert.match(message, /فحص Docker المعزول: ⏸️ لم يتم تشغيله/);
  assert.match(message, /السماح بالتنفيذ: ❌ لا/);
  assert.match(message, /تم النشر: ❌ لا/);
  assert.match(message, /فحص تشغيل التطبيق ومسار الصحة داخل Docker/);
  assert.doesNotMatch(message, /PAYMENT_API_KEY/);
});
