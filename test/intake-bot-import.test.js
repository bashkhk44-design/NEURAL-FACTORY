'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runtimeDependencies = [
  '../db',
  '../project-db',
  '../ai-intake',
  'grammy'
];

function assertRuntimeDependenciesAreUnloaded(message) {
  for (const modulePath of runtimeDependencies) {
    assert.equal(
      require.cache[require.resolve(modulePath)],
      undefined,
      modulePath + ' ' + message
    );
  }
}

test('importing intake bot does not load runtime dependencies or start polling', () => {
  const beforeSigterm = process.listenerCount('SIGTERM');
  const beforeSigint = process.listenerCount('SIGINT');

  const intake = require('../intake-bot');

  assert.equal(typeof intake.createIntakeRuntime, 'function');
  assert.equal(typeof intake.startIntakeBot, 'function');
  assert.equal(typeof intake.stopIntakeBot, 'function');
  assert.equal(typeof intake.createIntakeWebhookRuntime, 'function');
  assertRuntimeDependenciesAreUnloaded('must not load during intake-bot import');

  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
});

test('stopping an unused intake runtime does not initialize dependencies', async () => {
  const { stopIntakeBot } = require('../intake-bot');

  await stopIntakeBot();

  assertRuntimeDependenciesAreUnloaded('must remain unloaded when stopping an unused runtime');
});


test('injected intake webhook runtime handles updates without starting polling or loading Node dependencies', async () => {
  const { createIntakeRuntime } = require('../intake-bot');
  const handled = [];
  let startCalls = 0;
  let initCalls = 0;
  let stopCalls = 0;
  let registeredHandlers = 0;

  const fakeBot = {
    async init() { initCalls += 1; },
    command() { registeredHandlers += 1; return this; },
    callbackQuery() { registeredHandlers += 1; return this; },
    on() { registeredHandlers += 1; return this; },
    catch() { return this; },
    async handleUpdate(update) { handled.push(update); return 'handled'; },
    async start() { startCalls += 1; throw new Error('polling must not start in webhook mode'); },
    async stop() { stopCalls += 1; }
  };

  const noop = async () => null;
  const dependencies = {
    Bot: class FakeBot {},
    InlineKeyboard: class FakeInlineKeyboard {},
    pool: { query: noop },
    createClientProjectWithSession: noop,
    setProjectBusinessType: noop,
    updateProjectName: noop,
    updateClientProjectStatus: noop,
    addConversationMessage: noop,
    getIntakeSession: noop,
    getProjectConversation: noop,
    saveIntakeSession: noop,
    deleteIntakeSession: noop,
    approveProjectSpec: noop,
    processIntakeTurn: noop,
    advanceFallbackIntake: () => ({ data: {}, assistantMessage: 'fallback' })
  };

  const runtime = createIntakeRuntime({
    dependencies,
    createBot: token => {
      assert.equal(token, 'injected-test-token');
      return fakeBot;
    }
  });
  const webhook = await runtime.createWebhookRuntime({ token: 'injected-test-token' });

  assert.ok(registeredHandlers > 0, 'intake handlers should be registered on the injected bot');
  assert.equal(initCalls, 1, 'intake bot must initialize before webhook updates');
  assert.equal(startCalls, 0, 'webhook mode must not start long polling');
  assert.equal(await webhook.handleUpdate({ update_id: 123, message: { text: '/start' } }), 'handled');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].update_id, 123);
  assert.throws(() => webhook.handleUpdate({ update_id: -1 }), /valid Telegram update/);
  await webhook.stop();
  assert.equal(stopCalls, 0, 'webhook cleanup must not call the polling stop lifecycle');
  assertRuntimeDependenciesAreUnloaded('must stay unloaded when dependencies are injected');
});
