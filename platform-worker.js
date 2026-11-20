'use strict';

require('dotenv').config();

const { createQueueWorker } = require('./queue-worker');
const { createPlatformBotUpdateHandler } = require('./platform-bot-update-handler');
const { JOB_TYPES } = require('./platform-bot-update-handler');

function validatePlatformWorkerEnvironment(env = process.env) {
  if (env.BOSS_DATABASE_TARGET !== 'staging') {
    throw new Error('Platform worker requires BOSS_DATABASE_TARGET=staging');
  }
  if (typeof env.STAGING_DATABASE_URL !== 'string' || !env.STAGING_DATABASE_URL.trim()) {
    throw new Error('Platform worker requires STAGING_DATABASE_URL');
  }
  const { validateWorkerEnvironment } = require('./worker');
  validateWorkerEnvironment(env);
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID', 'INTAKE_BOT_TOKEN']) {
    if (typeof env[name] !== 'string' || !env[name].trim()) {
      throw new Error(name + ' is required for the platform Telegram worker');
    }
  }
  if (!/^\d+$/.test(env.TELEGRAM_ADMIN_ID)) {
    throw new Error('TELEGRAM_ADMIN_ID must be a numeric Telegram user ID');
  }
  const { validatePlatformBotWorkerEnvironment } = require('./platform-bot-worker');
  if (!validatePlatformBotWorkerEnvironment(env)) {
    throw new Error('PLATFORM_BOT_WEBHOOK_MODE=enabled is required to start the platform worker');
  }
  return true;
}

function createPlatformWorker({
  pool,
  runtimes,
  pollIntervalMs = 1000,
  leaseSeconds = 120,
  workerId,
  logger = console,
  queueApi
}) {
  const handleUpdate = createPlatformBotUpdateHandler({ pool, runtimes, leaseSeconds });
  const options = {
    pool,
    handlers: {
      [JOB_TYPES.master]: handleUpdate,
      [JOB_TYPES.intake]: handleUpdate
    },
    pollIntervalMs,
    leaseSeconds,
    logger
  };
  if (workerId) options.workerId = workerId;
  if (queueApi) options.queueApi = queueApi;
  return createQueueWorker(options);
}

async function main() {
  validatePlatformWorkerEnvironment();
  const db = require('./db');
  const { createMasterRuntime } = require('./telegram-master');
  const { createIntakeRuntime } = require('./intake-bot');

  const master = createMasterRuntime({
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminId: process.env.TELEGRAM_ADMIN_ID
  });
  const masterWebhook = await master.createWebhookRuntime();
  const intake = createIntakeRuntime();
  const intakeWebhook = await intake.createWebhookRuntime({
    token: process.env.INTAKE_BOT_TOKEN
  });

  const leaseSeconds = Number(process.env.QUEUE_LEASE_SECONDS || 120);
  const worker = createPlatformWorker({
    pool: db.pool,
    runtimes: { master: masterWebhook, intake: intakeWebhook },
    pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS || 1000),
    leaseSeconds
  });

  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    console.log('Platform Telegram worker stopping: ' + signal);
    await worker.stop();
    await Promise.allSettled([masterWebhook.stop(), intakeWebhook.stop()]);
    await db.pool.end();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
    console.error('Platform worker shutdown failed:', error.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
    console.error('Platform worker shutdown failed:', error.message);
    process.exitCode = 1;
  }));

  console.log('Platform Telegram worker started: ' + worker.workerId);
  await worker.start();
}

if (require.main === module) {
  main().catch(error => {
    console.error('PLATFORM TELEGRAM WORKER STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { validatePlatformWorkerEnvironment, createPlatformWorker, main };
