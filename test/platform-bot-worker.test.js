'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePlatformBotWorkerEnvironment,
  createPlatformBotWorker
} = require('../platform-bot-worker');

function enabledEnv(overrides = {}) {
  return {
    PLATFORM_BOT_WEBHOOK_MODE: 'enabled',
    TELEGRAM_BOT_TOKEN: 'master-token',
    INTAKE_BOT_TOKEN: 'intake-token',
    TELEGRAM_ADMIN_ID: '12345',
    ...overrides
  };
}

test('platform bot worker stays disabled unless explicitly enabled', async () => {
  let factoryCalls = 0;
  const worker = await createPlatformBotWorker({
    pool: { query() {} },
    env: { PLATFORM_BOT_WEBHOOK_MODE: 'disabled' },
    createMasterRuntime() { factoryCalls += 1; },
    createIntakeRuntime() { factoryCalls += 1; }
  });
  assert.equal(worker.enabled, false);
  assert.deepEqual(worker.handlers, {});
  await worker.close();
  assert.equal(factoryCalls, 0);
  assert.equal(validatePlatformBotWorkerEnvironment({}), false);
});

test('platform bot worker requires separate master and intake credentials when enabled', () => {
  assert.throws(
    () => validatePlatformBotWorkerEnvironment(enabledEnv({ INTAKE_BOT_TOKEN: 'master-token' })),
    /different tokens/
  );
  assert.throws(
    () => validatePlatformBotWorkerEnvironment(enabledEnv({ TELEGRAM_ADMIN_ID: '' })),
    /TELEGRAM_ADMIN_ID is required/
  );
  assert.throws(
    () => validatePlatformBotWorkerEnvironment({ PLATFORM_BOT_WEBHOOK_MODE: 'yes' }),
    /must be enabled or disabled/
  );
});

test('platform bot worker wires both system identities to no-polling runtimes and closes resources', async () => {
  const events = [];
  let intakeOptions;
  const masterRuntime = {
    bot: {
      api: {
        async sendMessage(chatId, message, extra) {
          events.push({ type: 'admin-notification', chatId, message, extra });
        }
      }
    },
    createWebhookRuntime() {
      events.push({ type: 'master-webhook-created' });
      return {
        async handleUpdate(update) { events.push({ type: 'master-update', update }); },
        async stop() { events.push({ type: 'master-stopped' }); }
      };
    },
    async closeWebhookResources() { events.push({ type: 'master-resources-closed' }); }
  };
  const intakeRuntime = {
    async createWebhookRuntime(options) {
      intakeOptions = options;
      events.push({ type: 'intake-webhook-created' });
      return {
        async handleUpdate(update) { events.push({ type: 'intake-update', update }); },
        async stop() { events.push({ type: 'intake-stopped' }); }
      };
    }
  };

  const worker = await createPlatformBotWorker({
    pool: { query() {} },
    env: enabledEnv(),
    createMasterRuntime(options) {
      assert.equal(options.token, 'master-token');
      assert.equal(options.adminId, '12345');
      return masterRuntime;
    },
    createIntakeRuntime() { return intakeRuntime; }
  });

  assert.equal(worker.enabled, true);
  assert.deepEqual(Object.keys(worker.handlers).sort(), [
    'telegram.intake.update',
    'telegram.master.update'
  ]);
  assert.equal(intakeOptions.token, 'intake-token');
  await intakeOptions.notifyAdmin({ text: 'hello', extra: { disable_notification: true } });
  assert.deepEqual(events.find(event => event.type === 'admin-notification'), {
    type: 'admin-notification',
    chatId: '12345',
    message: 'hello',
    extra: { disable_notification: true }
  });

  await worker.close();
  assert.ok(events.some(event => event.type === 'intake-stopped'));
  assert.ok(events.some(event => event.type === 'master-stopped'));
  assert.ok(events.some(event => event.type === 'master-resources-closed'));
});


test('platform bot worker closes every runtime even when one stop operation fails', async () => {
  const events = [];
  const worker = await createPlatformBotWorker({
    pool: { query() {} },
    env: enabledEnv(),
    createMasterRuntime() {
      return {
        bot: { api: { async sendMessage() {} } },
        createWebhookRuntime() {
          return {
            async handleUpdate() {},
            async stop() { events.push('master-stopped'); }
          };
        },
        async closeWebhookResources() { events.push('master-resources-closed'); }
      };
    },
    createIntakeRuntime() {
      return {
        async createWebhookRuntime() {
          return {
            async handleUpdate() {},
            async stop() {
              events.push('intake-stop-attempted');
              throw new Error('intake stop failed');
            }
          };
        }
      };
    }
  });

  await assert.rejects(worker.close(), /One or more platform bot resources failed to close/);
  assert.deepEqual(events, [
    'intake-stop-attempted',
    'master-stopped',
    'master-resources-closed'
  ]);
});
