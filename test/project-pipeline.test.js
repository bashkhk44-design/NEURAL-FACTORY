'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function loadPipeline(overrides = {}) {
  const state = {
    calls: [],
    jobs: [],
    lockReleased: 0,
    releaseCreated: 0,
    deploymentPrepared: 0,
    ...overrides.state
  };
  const designJob = overrides.designJob === undefined ? {
    id: 31,
    spec_version: 3,
    analysis: {
      artifact: {
        specVersion: 3,
        sourceFingerprint: 'a'.repeat(64)
      }
    }
  } : overrides.designJob;
  const approvals = overrides.approvals || {
    construction_points_approved: true,
    design_approved: true
  };

  const stubs = {
    './project-db': {
      createProjectAiJob: async ({ jobType }) => {
        state.calls.push('create-job:' + jobType);
        return { id: state.jobs.length + 1, status: 'queued' };
      },
      getLatestCompletedProjectAiJob: async ({ jobType }) => {
        state.calls.push('latest-job:' + jobType);
        if (jobType === 'design') return designJob;
        return null;
      },
      getProjectApprovalState: async () => {
        state.calls.push('get-approvals');
        return approvals;
      },
      startProjectAiJobAttempt: async (_id, options) => {
        state.calls.push('start-attempt');
        return { id: state.jobs.length + 1, attempt_no: 1, options };
      },
      completeProjectAiJobAttempt: async () => {
        state.calls.push('complete-attempt');
        return true;
      },
      failProjectAiJobAttempt: async () => {
        state.calls.push('fail-attempt');
        return true;
      },
      acquireProjectPipelineLock: async () => {
        state.calls.push('acquire-lock');
        return overrides.lock === undefined ? { id: 'lock-1' } : overrides.lock;
      },
      releaseProjectPipelineLock: async () => {
        state.calls.push('release-lock');
        state.lockReleased++;
      },
      getProjectSecretNames: async () => []
    },
    './gemini-analyst': {
      analyzeProject: async () => {
        state.calls.push('analysis');
        if (overrides.analysisError) throw overrides.analysisError;
        return { summary: 'analysis-ok' };
      }
    },
    './ai-builder': {
      buildProject: async () => {
        state.calls.push('build');
        if (overrides.buildError) throw overrides.buildError;
        return { files: [{ path: 'index.js', content: 'ok' }] };
      }
    },
    './ai-tester': {
      testProjectBundle: async () => {
        state.calls.push('test');
        return overrides.testResult || { passed: true, sandbox: { executionStatus: 'completed' } };
      }
    },
    './ai-fixer': {
      fixProject: async () => {
        state.calls.push('fix');
        return { passed: false, bundle: null, testResult: { passed: false } };
      },
      canAttemptFix: () => false
    },
    './ai-deployer': {
      prepareDeployment: async () => {
        state.calls.push('prepare-deployment');
        state.deploymentPrepared++;
        return { ready: false, checks: [] };
      }
    },
    './project-release': {
      buildReleaseReport: () => {
        state.calls.push('build-release-report');
        return { report: true };
      },
      createReleaseCandidate: async () => {
        state.calls.push('create-release');
        state.releaseCreated++;
        return { id: 99, status: 'awaiting_customer' };
      }
    }
  };

  const target = path.resolve(__dirname, '../project-pipeline.js');
  const previousCached = require.cache[target];
  delete require.cache[target];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  let pipeline;
  try {
    pipeline = require(target);
  } finally {
    Module._load = originalLoad;
    delete require.cache[target];
    if (previousCached) require.cache[target] = previousCached;
  }
  return { ...pipeline, state };
}

function validProject(overrides = {}) {
  return {
    project_id: 7,
    spec_version: 3,
    spec: { description: 'Test project' },
    telegram_user_id: '123456',
    ...overrides
  };
}

test('pipeline refuses to start without a completed design for the current specification', async () => {
  const { runProjectPipeline, state } = loadPipeline({ designJob: null });
  await assert.rejects(
    runProjectPipeline({ project: validProject(), adminTelegramId: '123' }),
    /يجب إكمال تصميم المشروع الحالي/
  );
  assert.equal(state.calls.includes('acquire-lock'), false);
  assert.equal(state.calls.includes('analysis'), false);
});

test('pipeline refuses a design generated for an older specification version', async () => {
  const { runProjectPipeline, state } = loadPipeline({
    designJob: { id: 31, spec_version: 2, analysis: { artifact: { specVersion: 2, sourceFingerprint: 'b'.repeat(64) } } }
  });
  await assert.rejects(
    runProjectPipeline({ project: validProject(), adminTelegramId: '123' }),
    /يجب إكمال تصميم المشروع الحالي/
  );
  assert.equal(state.calls.includes('acquire-lock'), false);
});

test('pipeline refuses to acquire its execution lock until both manager approvals exist', async () => {
  const { runProjectPipeline, state } = loadPipeline({
    approvals: { construction_points_approved: true, design_approved: false }
  });
  await assert.rejects(
    runProjectPipeline({ project: validProject(), adminTelegramId: '123' }),
    /التنفيذ محظور حتى اعتماد نقاط البناء ووثيقة التصميم/
  );
  assert.equal(state.calls.includes('acquire-lock'), false);
  assert.equal(state.calls.includes('analysis'), false);
});

test('pipeline builds, tests, prepares a non-deployed release and always releases its lock', async () => {
  const { runProjectPipeline, state } = loadPipeline();
  const result = await runProjectPipeline({
    project: validProject(),
    adminTelegramId: '123',
    onProgress: async () => {}
  });

  assert.equal(result.completed, true);
  assert.equal(result.deployed, false);
  assert.equal(result.releaseCandidate.id, 99);
  assert.deepEqual(
    state.calls.filter(call => ['analysis', 'build', 'test', 'prepare-deployment', 'create-release'].includes(call)),
    ['analysis', 'build', 'test', 'prepare-deployment', 'create-release']
  );
  assert.equal(state.deploymentPrepared, 1);
  assert.equal(state.releaseCreated, 1);
  assert.equal(state.lockReleased, 1);
});

test('pipeline does not prepare deployment or create a release when sandbox tests fail', async () => {
  const { runProjectPipeline, state } = loadPipeline({
    testResult: { passed: false, sandbox: { executionStatus: 'completed' } }
  });
  const result = await runProjectPipeline({
    project: validProject(),
    adminTelegramId: '123'
  });

  assert.equal(result.completed, false);
  assert.equal(result.stage, 'testing');
  assert.equal(state.deploymentPrepared, 0);
  assert.equal(state.releaseCreated, 0);
  assert.equal(state.lockReleased, 1);
  assert.equal(state.calls.includes('prepare-deployment'), false);
});

test('pipeline releases its lock and records the failed stage when a build throws', async () => {
  const { runProjectPipeline, state } = loadPipeline({
    buildError: new Error('synthetic build failure')
  });
  await assert.rejects(
    runProjectPipeline({ project: validProject(), adminTelegramId: '123' }),
    /synthetic build failure/
  );
  assert.equal(state.calls.includes('fail-attempt'), true);
  assert.equal(state.lockReleased, 1);
  assert.equal(state.deploymentPrepared, 0);
  assert.equal(state.releaseCreated, 0);
});

test('pipeline does not run stages when another execution owns the project lock', async () => {
  const { runProjectPipeline, state } = loadPipeline({ lock: null });
  await assert.rejects(
    runProjectPipeline({ project: validProject(), adminTelegramId: '123' }),
    /هناك عملية تنفيذ أخرى تعمل على هذا المشروع/
  );
  assert.equal(state.calls.includes('analysis'), false);
  assert.equal(state.lockReleased, 0);
});
