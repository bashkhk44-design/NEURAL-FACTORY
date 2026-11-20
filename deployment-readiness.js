'use strict';

const crypto = require('node:crypto');

const REQUIRED_DEPLOYMENT_CHECKS = Object.freeze([
  'artifact_integrity',
  'target_configured',
  'runtime_compatibility',
  'secrets_available',
  'rollback_plan',
  'health_check'
]);

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isNumericId(value) {
  return /^\d+$/.test(String(value ?? ''));
}

function isNonNegativeSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

function evaluateDeploymentReadiness({
  release,
  authorization,
  target,
  executionApproval,
  checks
} = {}) {
  const blockers = [];

  if (!release || !isNumericId(release.id) || release.status !== 'approved' ||
      !isSha256(release.artifact_sha256)) {
    blockers.push('release_not_approved_or_invalid');
  }

  if (!authorization || authorization.status !== 'authorized' ||
      !isNumericId(authorization.id) ||
      String(authorization.release_id) !== String(release?.id ?? '') ||
      !isNumericId(authorization.authorized_by) ||
      !isSha256(authorization.authorization_sha256)) {
    blockers.push('deployment_authorization_missing_or_mismatched');
  }

  const report = release?.artifact?.report;
  const summary = report?.tests?.summary;
  const validTestCounts = Boolean(summary) &&
    isNonNegativeSafeInteger(summary.tests) &&
    isNonNegativeSafeInteger(summary.passed) &&
    isNonNegativeSafeInteger(summary.failed ?? 0) &&
    isNonNegativeSafeInteger(summary.skipped ?? 0) &&
    isNonNegativeSafeInteger(summary.todo ?? 0) &&
    isNonNegativeSafeInteger(summary.cancelled ?? 0) &&
    Number(summary.tests) > 0 &&
    Number(summary.passed) === Number(summary.tests) &&
    Number(summary.failed ?? 0) === 0 &&
    Number(summary.skipped ?? 0) === 0 &&
    Number(summary.todo ?? 0) === 0 &&
    Number(summary.cancelled ?? 0) === 0;

  if (report?.tests?.status !== 'passed' ||
      report?.tests?.executionStatus !== 'completed' ||
      !validTestCounts ||
      !Array.isArray(report.tests.acceptanceTests) ||
      report.tests.acceptanceTests.length < 1 ||
      report.tests.acceptanceTests.length > 1000 ||
      !report.tests.acceptanceTests.every(item => item && item.passed === true)) {
    blockers.push('release_test_evidence_incomplete');
  }

  const validTarget = target &&
    typeof target.provider === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(target.provider) &&
    typeof target.serviceId === 'string' && target.serviceId.trim().length > 0 &&
    target.serviceId.length <= 200 &&
    ['staging', 'production'].includes(target.environment) &&
    target.confirmed === true &&
    target.artifactSha256 === release?.artifact_sha256;
  if (!validTarget) blockers.push('deployment_target_missing_or_unconfirmed');

  const validExecutionApproval = executionApproval &&
    executionApproval.status === 'approved' &&
    isNumericId(executionApproval.approvedBy) &&
    isSha256(executionApproval.approvalSha256) &&
    executionApproval.releaseId !== undefined &&
    String(executionApproval.releaseId) === String(release?.id ?? '') &&
    executionApproval.artifactSha256 === release?.artifact_sha256 &&
    executionApproval.provider === target?.provider &&
    executionApproval.serviceId === target?.serviceId &&
    executionApproval.environment === target?.environment;
  if (!validExecutionApproval) blockers.push('separate_execution_approval_missing_or_mismatched');

  const suppliedChecks = Array.isArray(checks) ? checks : [];
  const checkMap = new Map();
  for (const check of suppliedChecks) {
    if (!check || typeof check.name !== 'string' || checkMap.has(check.name)) {
      blockers.push('deployment_checks_invalid_or_duplicated');
      continue;
    }
    checkMap.set(check.name, check);
  }

  for (const name of REQUIRED_DEPLOYMENT_CHECKS) {
    const check = checkMap.get(name);
    if (!check || check.passed !== true ||
        typeof check.evidence !== 'string' || !check.evidence.trim() ||
        check.evidence.length > 1000) {
      blockers.push('deployment_check_failed_or_missing:' + name);
    }
  }

  for (const check of suppliedChecks) {
    if (check && check.passed !== true && typeof check.name === 'string' &&
        !REQUIRED_DEPLOYMENT_CHECKS.includes(check.name)) {
      blockers.push('additional_deployment_check_failed:' + check.name.slice(0, 80));
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  const ready = uniqueBlockers.length === 0;
  const readinessPayload = {
    release: {
      id: String(release?.id ?? ''),
      status: release?.status ?? null,
      artifactSha256: release?.artifact_sha256 || null,
      testEvidence: {
        status: report?.tests?.status ?? null,
        executionStatus: report?.tests?.executionStatus ?? null,
        summary: summary ? {
          tests: summary.tests ?? null,
          passed: summary.passed ?? null,
          failed: summary.failed ?? null,
          skipped: summary.skipped ?? null,
          todo: summary.todo ?? null,
          cancelled: summary.cancelled ?? null
        } : null,
        acceptanceTests: Array.isArray(report?.tests?.acceptanceTests)
          ? report.tests.acceptanceTests.map(item => ({
            id: String(item?.id ?? ''),
            name: String(item?.name ?? ''),
            passed: item?.passed === true
          }))
          : null
      }
    },
    authorization: {
      id: String(authorization?.id ?? ''),
      releaseId: String(authorization?.release_id ?? ''),
      authorizedBy: String(authorization?.authorized_by ?? ''),
      status: authorization?.status ?? null,
      authorizationSha256: authorization?.authorization_sha256 || null
    },
    target: target ? {
      provider: target.provider ?? null,
      serviceId: target.serviceId ?? null,
      environment: target.environment ?? null,
      artifactSha256: target.artifactSha256 ?? null,
      confirmed: target.confirmed === true
    } : null,
    executionApproval: {
      status: executionApproval?.status ?? null,
      approvedBy: String(executionApproval?.approvedBy ?? ''),
      approvalSha256: executionApproval?.approvalSha256 || null,
      releaseId: String(executionApproval?.releaseId ?? ''),
      artifactSha256: executionApproval?.artifactSha256 || null,
      provider: executionApproval?.provider ?? null,
      serviceId: executionApproval?.serviceId ?? null,
      environment: executionApproval?.environment ?? null
    },
    checks: suppliedChecks.map(item => ({
      name: String(item?.name || ''),
      passed: item?.passed === true,
      evidence: String(item?.evidence || '').slice(0, 1000)
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    blockers: uniqueBlockers
  };

  return {
    readyForManualExecutionReview: ready,
    executionAllowed: false,
    deployed: false,
    blockers: uniqueBlockers,
    readinessSha256: sha256(stableJson(readinessPayload))
  };
}

module.exports = {
  REQUIRED_DEPLOYMENT_CHECKS,
  evaluateDeploymentReadiness
};
