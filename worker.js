'use strict';

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const { Pool } = require('pg');
const { normalizeJobTypes } = require('./platform-queue');
const { createQueueWorker } = require('./queue-worker');
const { createTelegramUpdateHandler } = require('./telegram-update-handler');
const { createPlatformBotWorker, validatePlatformBotWorkerEnvironment } = require('./platform-bot-worker');

function getWorkerSslConfig(env = process.env) {
  return env.DATABASE_SSL === 'disable' ? false : true;
}

function validateWorkerEnvironment(env = process.env) {
  validatePlatformBotWorkerEnvironment(env);
  const databaseUrl = require('./database-config').getDatabaseUrl(env);
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('Database URL must use the PostgreSQL protocol');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(env.BOTS_ENCRYPTION_KEY || '')) {
    throw new Error('BOTS_ENCRYPTION_KEY must be a 32-byte hex key');
  }
  if (env.DATABASE_SSL !== undefined && !['require', 'disable'].includes(env.DATABASE_SSL)) {
    throw new Error('DATABASE_SSL must be either require or disable');
  }
  const integerSettings = [
    ['WORKER_DB_POOL_MAX', 1, 20],
    ['QUEUE_POLL_INTERVAL_MS', 100, 60000],
    ['QUEUE_LEASE_SECONDS', 10, 86400]
  ];
  for (const [name, minimum, maximum] of integerSettings) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (!/^\d+$/.test(String(raw))) {
      throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum);
    }
  }
  return true;
}



function resolveWorkerHandlersPath(modulePath, projectRoot = __dirname) {
  if (typeof modulePath !== 'string' || !modulePath.trim()) {
    throw new TypeError('JOB_HANDLERS_MODULE must be a non-empty path');
  }
  if (path.extname(modulePath) !== '.js') {
    throw new Error('Custom worker handlers must use a .js file');
  }

  const root = fs.realpathSync(projectRoot);
  const directory = fs.realpathSync(path.join(root, 'worker-handlers'));

  const inside = (parent, candidate) => {
    const relative = path.relative(parent, candidate);
    return relative !== '' && relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative);
  };

  if (!inside(root, directory)) {
    throw new Error('worker-handlers directory must remain inside the project');
  }

  const resolved = fs.realpathSync(path.resolve(root, modulePath));
  if (!inside(directory, resolved)) {
    throw new Error('JOB_HANDLERS_MODULE must resolve inside worker-handlers');
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error('JOB_HANDLERS_MODULE must point to a file');
  }
  return resolved;
}

function mergeWorkerHandlers(currentHandlers, loadedModule) {
  if (!currentHandlers || typeof currentHandlers !== 'object' || Array.isArray(currentHandlers)) {
    throw new TypeError('Existing worker handlers must be an object');
  }

  const additions = loadedModule &&
    typeof loadedModule === 'object' &&
    Object.prototype.hasOwnProperty.call(loadedModule, 'handlers')
      ? loadedModule.handlers
      : loadedModule;

  if (!additions || typeof additions !== 'object' || Array.isArray(additions)) {
    throw new TypeError('Custom worker module must export a handlers object');
  }

  const entries = Object.entries(additions);
  if (entries.length === 0) {
    throw new TypeError('Custom worker module must register at least one handler');
  }

  normalizeJobTypes(entries.map(([jobType]) => jobType));

  for (const [jobType, handler] of entries) {
    if (Object.prototype.hasOwnProperty.call(currentHandlers, jobType)) {
      throw new Error('Custom worker handler cannot replace existing job type: ' + jobType);
    }
    if (typeof handler !== 'function') {
      throw new TypeError('Custom worker handler must be a function: ' + jobType);
    }
  }

  return { ...currentHandlers, ...Object.fromEntries(entries) };
}

async function main() {
  validateWorkerEnvironment();

  const { decryptToken } = require('./db');
  const pool = new Pool({
    connectionString: require('./database-config').getDatabaseUrl(process.env),
    ssl: getWorkerSslConfig(),
    max: Number(process.env.WORKER_DB_POOL_MAX || 2),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  let handlers = {
    'telegram.update': createTelegramUpdateHandler({ pool, decryptToken })
  };

  let platformBotWorker;
  try {
    platformBotWorker = await createPlatformBotWorker({
      pool,
      env: process.env,
      leaseSeconds: Number(process.env.QUEUE_LEASE_SECONDS || 120)
    });
    Object.assign(handlers, platformBotWorker.handlers);
  } catch (error) {
    await pool.end();
    throw error;
  }

  try {
    if (process.env.JOB_HANDLERS_MODULE) {
      const handlersPath = resolveWorkerHandlersPath(process.env.JOB_HANDLERS_MODULE);
      const loaded = require(handlersPath);
      handlers = mergeWorkerHandlers(handlers, loaded);
    }
  } catch (error) {
    try { await platformBotWorker.close(); } finally { await pool.end(); }
    throw error;
  }

  const worker = createQueueWorker({
    pool,
    handlers,
    pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS || 1000),
    leaseSeconds: Number(process.env.QUEUE_LEASE_SECONDS || 120)
  });

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Queue worker stopping: ' + signal);
    try {
      await worker.stop();
    } finally {
      try {
        await platformBotWorker.close();
      } finally {
        await pool.end();
      }
    }
  };

  process.once('SIGTERM', () => shutdown('SIGTERM').catch(err => {
    console.error('Worker shutdown failed:', err.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(err => {
    console.error('Worker shutdown failed:', err.message);
    process.exitCode = 1;
  }));

  console.log('Queue worker started: ' + worker.workerId);
  await worker.start();
}

if (require.main === module) {
  main().catch(error => {
    console.error('QUEUE WORKER STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, validateWorkerEnvironment, getWorkerSslConfig, mergeWorkerHandlers, resolveWorkerHandlersPath };
