'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('importing telegram master exposes a factory without starting runtime', () => {
  const beforeSigterm = process.listenerCount('SIGTERM');
  const beforeSigint = process.listenerCount('SIGINT');
  const beforeReady = process.listenerCount('boss:runtime-ready');

  const master = require('../telegram-master');

  assert.equal(typeof master.createMasterRuntime, 'function');
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
  assert.equal(process.listenerCount('boss:runtime-ready'), beforeReady);
});


test('injected master webhook runtime handles updates without starting polling or loading Node dependencies', async () => {
  const { createMasterRuntime } = require('../telegram-master');
  const handled = [];
  let startCalls = 0;
  let initCalls = 0;
  let registeredHandlers = 0;

  const fakeBot = {
    async init() { initCalls += 1; },
    command() { registeredHandlers += 1; return this; },
    callbackQuery() { registeredHandlers += 1; return this; },
    on() { registeredHandlers += 1; return this; },
    catch() { return this; },
    async handleUpdate(update) { handled.push(update); return 'master-handled'; },
    async start() { startCalls += 1; throw new Error('master polling must not start in webhook mode'); },
    async stop() { startCalls += 100; }
  };

  const noop = async () => null;
  const dependencies = {
    Bot: class FakeBot {},
    Keyboard: class FakeKeyboard {},
    InlineKeyboard: class FakeInlineKeyboard {},
    isPrivateAdmin: () => true,
    pool: { query: noop, end: noop },
    initDatabase: noop,
    insertTelegramBot: noop,
    acquireTelegramRuntimeLock: noop,
    isTelegramRuntimeLockHeld: noop,
    releaseTelegramRuntimeLock: noop,
    setRuntimeLockFailureHandler: noop,
    startBotRuntime: noop,
    stopBotRuntime: noop,
    startBotById: noop,
    stopBotById: noop,
    getRunningBotCount: noop,
    getBotRuntimeStatus: noop,
    createProjectAiJob: noop,
    getLatestCompletedProjectAiJob: noop,
    markProjectAiJobRunning: noop,
    completeProjectAiJob: noop,
    failProjectAiJob: noop,
    recoverInterruptedProjectAiJobs: noop,
    getProjectApprovalState: noop,
    approveProjectMilestone: noop,
    buildConstructionPoints: () => ({ sections: [] }),
    startIntakeBot: noop,
    stopIntakeBot: noop,
    analyzeProject: noop,
    designProject: noop,
    runProjectPipeline: noop,
    getGeminiModel: noop,
    getReleaseCandidate: noop,
    decideRelease: noop,
    authorizeDeployment: noop,
    reviewDeploymentReadiness: noop,
    formatDeploymentReadinessReview: noop,
    enqueueDeploymentPreflight: noop,
    getLatestDeploymentPreflightJob: noop,
    formatDeploymentPreflightJob: noop
  };

  const runtime = createMasterRuntime({
    env: {},
    token: 'injected-master-token',
    adminId: '12345',
    dependencies,
    createBot: token => {
      assert.equal(token, 'injected-master-token');
      return fakeBot;
    }
  });
  const webhook = await runtime.createWebhookRuntime();

  assert.equal(initCalls, 1, 'master bot must initialize before webhook updates');

  assert.ok(registeredHandlers > 0, 'master handlers should be registered');
  assert.equal(startCalls, 0, 'creating a webhook runtime must not start polling');
  assert.equal(await webhook.handleUpdate({ update_id: 456, message: { text: '/start' } }), 'master-handled');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].update_id, 456);
  assert.throws(() => webhook.handleUpdate({ update_id: -1 }), /valid Telegram update/);
  await webhook.stop();
  assert.throws(() => webhook.handleUpdate({ update_id: 457 }), /stopped/);
  assert.equal(startCalls, 0);
});
