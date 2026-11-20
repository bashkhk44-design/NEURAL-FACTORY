'use strict';

const { createPlatformBotUpdateHandler } = require('./platform-bot-update-handler');

function validatePlatformBotWorkerEnvironment(env = {}) {
  if (env.PLATFORM_BOT_WEBHOOK_MODE === undefined || env.PLATFORM_BOT_WEBHOOK_MODE === 'disabled') return false;
  if (env.PLATFORM_BOT_WEBHOOK_MODE !== 'enabled') {
    throw new Error('PLATFORM_BOT_WEBHOOK_MODE must be enabled or disabled');
  }
  const required = ['TELEGRAM_BOT_TOKEN', 'INTAKE_BOT_TOKEN', 'TELEGRAM_ADMIN_ID'];
  for (const name of required) {
    if (typeof env[name] !== 'string' || !env[name].trim()) {
      throw new Error(name + ' is required when PLATFORM_BOT_WEBHOOK_MODE=enabled');
    }
  }
  if (env.TELEGRAM_BOT_TOKEN === env.INTAKE_BOT_TOKEN) {
    throw new Error('Master and intake Telegram bots must use different tokens');
  }
  return true;
}

async function createPlatformBotWorker({
  pool,
  env = {},
  createMasterRuntime,
  createIntakeRuntime,
  leaseSeconds = 120
}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('PostgreSQL queue pool is required');
  }

  if (!validatePlatformBotWorkerEnvironment(env)) {
    return {
      enabled: false,
      handlers: {},
      async close() {}
    };
  }

  const masterFactory = createMasterRuntime ||
    require('./telegram-master').createMasterRuntime;
  const intakeFactory = createIntakeRuntime ||
    require('./intake-bot').createIntakeRuntime;

  let masterRuntime = null;
  let masterWebhook = null;
  let intakeWebhook = null;
  try {
    masterRuntime = masterFactory({
      env,
      token: env.TELEGRAM_BOT_TOKEN,
      adminId: env.TELEGRAM_ADMIN_ID
    });
    if (!masterRuntime || typeof masterRuntime.createWebhookRuntime !== 'function') {
      throw new TypeError('Master runtime factory must expose createWebhookRuntime()');
    }

    masterWebhook = await masterRuntime.createWebhookRuntime();
    const intakeRuntime = intakeFactory();
    if (!intakeRuntime || typeof intakeRuntime.createWebhookRuntime !== 'function') {
      throw new TypeError('Intake runtime factory must expose createWebhookRuntime()');
    }

    intakeWebhook = await intakeRuntime.createWebhookRuntime({
      token: env.INTAKE_BOT_TOKEN,
      notifyAdmin: async ({ text, extra }) => {
        await masterRuntime.bot.api.sendMessage(env.TELEGRAM_ADMIN_ID, text, extra);
      }
    });
  } catch (error) {
    try { await intakeWebhook?.stop(); } catch (_) {}
    try { await masterWebhook?.stop(); } catch (_) {}
    try { await masterRuntime?.closeWebhookResources?.(); } catch (_) {}
    throw error;
  }

  const dispatch = createPlatformBotUpdateHandler({
    pool,
    leaseSeconds,
    runtimes: {
      master: masterWebhook,
      intake: intakeWebhook
    }
  });

  let closePromise = null;
  return {
    enabled: true,
    handlers: {
      'telegram.master.update': dispatch,
      'telegram.intake.update': dispatch
    },
    close() {
      if (!closePromise) {
        closePromise = (async () => {
          const failures = [];
          const stopped = await Promise.allSettled([
            Promise.resolve().then(() => intakeWebhook.stop()),
            Promise.resolve().then(() => masterWebhook.stop())
          ]);
          for (const result of stopped) {
            if (result.status === 'rejected') failures.push(result.reason);
          }
          try {
            await masterRuntime.closeWebhookResources?.();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length) {
            throw new AggregateError(failures, 'One or more platform bot resources failed to close');
          }
        })();
      }
      return closePromise;
    }
  };
}

module.exports = {
  validatePlatformBotWorkerEnvironment,
  createPlatformBotWorker
};
