'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableJson,
  buildReleaseReport,
  createImmutableReleaseArtifact
} = require('../project-release');

const project = {
  project_id: 7,
  project_name: 'Sample Restaurant',
  business_type: 'restaurant',
  spec_version: 3
};
const design = {
  artifact: { specVersion: 3, sourceFingerprint: 'a'.repeat(64) }
};
const testResult = {
  passed: true,
  sandbox: {
    executionStatus: 'completed',
    testSummary: { tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
    acceptanceTests: [{ acceptanceTestId: 'menu', passed: true }]
  }
};
const bundle = {
  files: [
    { path: 'index.js', content: "console.log('hello');" },
    { path: 'package.json', content: '{"name":"sample","version":"1.0.0"}' }
  ]
};

test('stable JSON produces deterministic key ordering', () => {
  assert.equal(stableJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test('release report requires approved-version design and completed passing sandbox', () => {
  const report = buildReleaseReport({ project, spec: {}, design, testResult, deployment: { ready: false, checks: [] } });
  assert.equal(report.approvals.customerSpec.specVersion, 3);
  assert.equal(report.tests.status, 'passed');
  assert.equal(report.deployment.deployed, false);
  assert.throws(() => buildReleaseReport({
    project, design: { artifact: { specVersion: 2, sourceFingerprint: 'x' } },
    testResult, deployment: {}
  }), /لا يطابق/);
  assert.throws(() => buildReleaseReport({
    project, design, testResult: { passed: false, sandbox: { executionStatus: 'completed' } },
    deployment: {}
  }), /نجاح اختبار مكتمل/);
});

test('release artifact hash is stable and independent of input file order', () => {
  const report = buildReleaseReport({ project, spec: {}, design, testResult, deployment: { ready: false, checks: [] } });
  const first = createImmutableReleaseArtifact({ report, bundle });
  const second = createImmutableReleaseArtifact({ report, bundle: { files: [...bundle.files].reverse() } });
  assert.equal(first.artifactSha256, second.artifactSha256);
  assert.equal(first.artifactBytes, second.artifactBytes);
  assert.match(first.artifactSha256, /^[a-f0-9]{64}$/);
});

test('release artifact rejects unsafe paths and malformed files', () => {
  const report = buildReleaseReport({ project, spec: {}, design, testResult, deployment: {} });
  assert.throws(() => createImmutableReleaseArtifact({
    report, bundle: { files: [{ path: '../secret', content: 'x' }] }
  }), /مسار ملف غير آمن/);
  assert.throws(() => createImmutableReleaseArtifact({
    report, bundle: { files: [{ path: 'x.js', content: 42 }] }
  }), /غير صالح/);
});

test('release artifact enforces bounded storage size', () => {
  const report = buildReleaseReport({ project, spec: {}, design, testResult, deployment: {} });
  assert.throws(() => createImmutableReleaseArtifact({
    report, bundle: { files: [{ path: 'large.txt', content: 'x'.repeat(4 * 1024 * 1024) }] }
  }), /4 ميغابايت/);
});

test('release report rejects skipped acceptance tests and incomplete summaries', () => {
  assert.throws(() => buildReleaseReport({
    project, spec: {}, design,
    testResult: {
      passed: true,
      sandbox: {
        executionStatus: 'completed',
        testSummary: { tests: 2, passed: 1, failed: 0, skipped: 1 },
        acceptanceTests: [{ acceptanceTestId: 'menu', passed: true }]
      }
    },
    deployment: {}
  }), /ملخص الاختبارات/);
  assert.throws(() => buildReleaseReport({
    project, spec: {}, design,
    testResult: {
      passed: true,
      sandbox: {
        executionStatus: 'completed',
        testSummary: { tests: 1, passed: 1 },
        acceptanceTests: [{ acceptanceTestId: 'menu', passed: false }]
      }
    },
    deployment: {}
  }), /ملخص الاختبارات/);
});

test('release artifact rejects Windows paths and duplicate paths', () => {
  const report = buildReleaseReport({ project, spec: {}, design, testResult, deployment: {} });
  assert.throws(() => createImmutableReleaseArtifact({
    report, bundle: { files: [{ path: 'C:\\secret.txt', content: 'x' }] }
  }), /مسار ملف غير آمن/);
  assert.throws(() => createImmutableReleaseArtifact({
    report, bundle: { files: [
      { path: 'same.js', content: 'one' },
      { path: 'same.js', content: 'two' }
    ] }
  }), /مسار مكرر/);
});
