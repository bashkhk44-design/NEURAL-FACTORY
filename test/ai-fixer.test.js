'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixProject, canAttemptFix } = require('../ai-fixer');

function bundle() {
  return {
    summary: 'sample',
    notes: [],
    files: [{
      path: 'package.json',
      content: JSON.stringify({
        name: 'sample-bot',
        version: '1.0.0',
        scripts: { start: 'node index.js' }
      })
    }, {
      path: 'index.js',
      content: "console.log('sample');"
    }]
  };
}

function testResult({ passed = false, executionStatus, repairable }) {
  return {
    passed,
    checks: [{ name: 'sandbox-runtime-tests', passed }],
    sandbox: { status: passed ? 'passed' : 'failed', executionStatus, repairable }
  };
}

const context = {
  project: { project_id: 1, project_name: 'Sample', business_type: 'other', spec: {} },
  analysis: { text: 'approved analysis' },
  design: { text: 'approved design' },
  designArtifact: { sourceFingerprint: 'fingerprint' },
  bundle: bundle(),
  maxAttempts: 1
};

test('AI FIXER does not call the model when sandbox execution is not confirmed', async () => {
  let modelCalls = 0;
  let testCalls = 0;
  const result = await fixProject({
    ...context,
    testRunner: async () => {
      testCalls++;
      return testResult({
        executionStatus: 'not_confirmed',
        repairable: false
      });
    },
    generate: async () => {
      modelCalls++;
      throw new Error('model must not be called');
    }
  });

  assert.equal(testCalls, 1);
  assert.equal(modelCalls, 0);
  assert.equal(result.passed, false);
  assert.equal(result.attempts.length, 0);
  assert.equal(result.originalPreserved, true);
});

test('AI FIXER repairs a completed failing test run and retests the candidate', async () => {
  let modelCalls = 0;
  let testCalls = 0;
  const result = await fixProject({
    ...context,
    testRunner: async () => {
      testCalls++;
      return testCalls === 1
        ? testResult({ executionStatus: 'completed', repairable: true })
        : testResult({ passed: true, executionStatus: 'completed', repairable: false });
    },
    generate: async () => {
      modelCalls++;
      return {
        text: JSON.stringify({ summary: 'fixed', notes: [], files: bundle().files }),
        provider: 'test-provider',
        model: 'test-model'
      };
    }
  });

  assert.equal(modelCalls, 1);
  assert.equal(testCalls, 2);
  assert.equal(result.passed, true);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.originalPreserved, true);
});

test('AI FIXER stops if sandbox execution becomes unconfirmed after a repair', async () => {
  let modelCalls = 0;
  let testCalls = 0;
  const result = await fixProject({
    ...context,
    maxAttempts: 2,
    testRunner: async () => {
      testCalls++;
      return testCalls === 1
        ? testResult({ executionStatus: 'completed', repairable: true })
        : testResult({ executionStatus: 'not_confirmed', repairable: false });
    },
    generate: async () => {
      modelCalls++;
      return {
        text: JSON.stringify({ summary: 'candidate', notes: [], files: bundle().files }),
        provider: 'test-provider',
        model: 'test-model'
      };
    }
  });

  assert.equal(modelCalls, 1);
  assert.equal(testCalls, 2);
  assert.equal(result.passed, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.testResult.sandbox.executionStatus, 'not_confirmed');
});

test('repair policy requires completed execution and an explicitly repairable failure', () => {
  assert.equal(canAttemptFix(testResult({
    executionStatus: 'completed',
    repairable: true
  })), true);
  assert.equal(canAttemptFix(testResult({
    executionStatus: 'not_confirmed',
    repairable: true
  })), false);
  assert.equal(canAttemptFix(testResult({
    executionStatus: 'completed',
    repairable: false
  })), false);
  assert.equal(canAttemptFix({
    passed: false,
    sandbox: {
      status: 'passed',
      executionStatus: 'completed',
      repairable: false
    }
  }), true);
  assert.equal(canAttemptFix({
    passed: false,
    sandbox: {
      status: 'failed',
      executionStatus: 'completed',
      repairable: false
    }
  }), false);
});
