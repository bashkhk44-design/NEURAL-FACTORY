'use strict';

const DEFAULT_MAX_BOTS = 100;

function createBotRuntime({
  pool,
  decryptToken,
  createCustomerBot,
  logger = console,
  maxBots = DEFAULT_MAX_BOTS,
  heartbeatIntervalMs = 30000,
  workerId = String(process.pid),
  requireLease = false,
  leaseSeconds = 90,
  onStatusPersistError = null,
  onLeaseLost = null
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (typeof decryptToken !== 'function') throw new TypeError('decryptToken(record) is required');
  if (typeof createCustomerBot !== 'function') throw new TypeError('createCustomerBot(record, token) is required');
  if (!Number.isInteger(maxBots) || maxBots < 1) throw new RangeError('maxBots must be a positive integer');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30) throw new RangeError('leaseSeconds must be at least 30 seconds');

  const runningBots = new Map();
  let runtimeStopping = false;
  let warnedStatusTable = false;
  let statusPersistenceFailureNotified = false;

  async function persistStatus(state) {
    try {
      if (requireLease) {
        const result = await pool.query(`
          UPDATE bot_runtime_status
          SET status = $2,
              last_started_at = CASE WHEN $2 = 'starting' THEN NOW() ELSE last_started_at END,
              last_heartbeat_at = NOW(),
              last_error_code = $4,
              last_error_message = $5,
              restart_count = restart_count + CASE WHEN $2 = 'starting' THEN 1 ELSE 0 END,
              updated_at = NOW()
          WHERE bot_id = $1
            AND worker_id = $3
            AND last_heartbeat_at >= NOW() - ($6::int * INTERVAL '1 second')
          RETURNING bot_id
        `, [
          state.id,
          state.status,
          String(workerId),
          state.lastErrorCode || null,
          state.lastErrorMessage || null,
          leaseSeconds
        ]);
        if (!result.rowCount) return false;
        return true;
      }

      await pool.query(`
        INSERT INTO bot_runtime_status
          (bot_id, status, worker_id, last_started_at, last_heartbeat_at,
           last_error_code, last_error_message, restart_count, updated_at)
        VALUES ($1, $2, $3,
          CASE WHEN $2 = 'starting' THEN NOW() ELSE NULL END,
          NOW(), $4, $5,
          CASE WHEN $2 = 'starting' THEN 1 ELSE 0 END, NOW())
        ON CONFLICT (bot_id) DO UPDATE SET
          status = EXCLUDED.status,
          worker_id = EXCLUDED.worker_id,
          last_started_at = CASE WHEN EXCLUDED.status = 'starting'
            THEN NOW() ELSE bot_runtime_status.last_started_at END,
          last_heartbeat_at = NOW(),
          last_error_code = EXCLUDED.last_error_code,
          last_error_message = EXCLUDED.last_error_message,
          restart_count = bot_runtime_status.restart_count +
            CASE WHEN EXCLUDED.status = 'starting' THEN 1 ELSE 0 END,
          updated_at = NOW()
      `, [
        state.id,
        state.status,
        String(workerId),
        state.lastErrorCode || null,
        state.lastErrorMessage || null
      ]);
      return true;
    } catch (error) {
      if (!warnedStatusTable) {
        warnedStatusTable = true;
        logger.error('BOT RUNTIME STATUS PERSISTENCE UNAVAILABLE:', error.message);
      }
      if (!statusPersistenceFailureNotified && typeof onStatusPersistError === 'function') {
        statusPersistenceFailureNotified = true;
        try { onStatusPersistError(error); } catch (callbackError) {
          logger.error('BOT RUNTIME STATUS FAILURE HANDLER ERROR:', callbackError.message);
        }
      }
      return false;
    }
  }

  function loseLease(state) {
    if (!requireLease || state.leaseLost) return;
    state.leaseLost = true;
    state.stopRequested = true;
    if (state.wakeRetry) state.wakeRetry();
    if (state.bot && typeof state.bot.stop === 'function') {
      Promise.resolve().then(() => state.bot && state.bot.stop()).catch(error => {
        logger.error('CUSTOMER BOT STOP AFTER LEASE LOSS ' + state.id + ':', error.message);
      });
    }
    if (!state.leaseLossNotified && typeof onLeaseLost === 'function') {
      state.leaseLossNotified = true;
      try { onLeaseLost(state.id); } catch (error) {
        logger.error('BOT LEASE LOSS HANDLER ERROR:', error.message);
      }
    }
    logger.error('CUSTOMER BOT ' + state.id + ' LOST ITS WORKER LEASE; stopping local runtime.');
  }

  function setStatus(state, status, error) {
    state.status = status;
    if (error) {
      state.lastErrorCode = String(error.error_code || error.code || '');
      state.lastErrorMessage = String(error.message || error).slice(0, 1000);
    } else if (status === 'running' || status === 'starting' || status === 'stopped') {
      state.lastErrorCode = null;
      state.lastErrorMessage = null;
    }
    const write = persistStatus(state);
    if (requireLease) {
      void write.then(owned => { if (!owned) loseLease(state); });
    }
    return write;
  }

  function waitForRetry(ms, state) {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
        state.wakeRetry = null;
        resolve();
      };
      state.retryTimer = setTimeout(finish, ms);
      state.wakeRetry = finish;
    });
  }

  async function runCustomerBot(record, state) {
    let token;
    try {
      token = decryptToken(record);
    } catch (error) {
      await setStatus(state, 'error', error);
      return;
    }

    state.heartbeatTimer = setInterval(() => {
      void persistStatus(state).then(owned => { if (!owned) loseLease(state); });
    }, heartbeatIntervalMs);
    if (typeof state.heartbeatTimer.unref === 'function') state.heartbeatTimer.unref();

    try {
      while (!runtimeStopping && !state.stopRequested && !state.leaseLost) {
        const startedAt = Date.now();
        try {
          const ownsLease = await setStatus(state, 'starting');
          if (requireLease && !ownsLease) { loseLease(state); break; }
          if (state.stopRequested || state.leaseLost) break;
          state.bot = createCustomerBot(record, token);
          await state.bot.start({
            onStart: info => {
              void setStatus(state, 'running').then(owned => {
                if (!owned) loseLease(state);
                else logger.log('Customer bot ' + state.id + ' running: @' + (info.username || record.username || 'unknown'));
              });
            }
          });
          if (runtimeStopping || state.stopRequested || state.leaseLost) break;
          throw new Error('Polling loop ended unexpectedly');
        } catch (error) {
          state.bot = null;
          if (runtimeStopping || state.stopRequested || state.leaseLost) break;
          const errorCode = Number(error.error_code || 0);
          if (errorCode === 409 || errorCode === 401) {
            await setStatus(state, errorCode === 409 ? 'conflict' : 'unauthorized', error);
            logger.error('CUSTOMER BOT ' + state.id + ' STOPPED:', errorCode, error.message || '');
            break;
          }
          if (Date.now() - startedAt >= 300000) state.retryCount = 0;
          state.retryCount += 1;
          const retryAfter = Number(error.parameters?.retry_after || 0);
          const delay = retryAfter > 0
            ? retryAfter * 1000 + 1000
            : Math.min(60000, 2000 * Math.pow(2, Math.min(state.retryCount - 1, 5))) + Math.floor(Math.random() * 1000);
          await setStatus(state, 'retrying', error);
          logger.error('CUSTOMER BOT ' + state.id + ' RETRY ' + state.retryCount + ' IN ' + Math.ceil(delay / 1000) + 's:', errorCode, error.message || '');
          await waitForRetry(delay, state);
        }
      }
    } finally {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
      state.bot = null;
      if (!state.leaseLost) {
        if (state.stopRequested || runtimeStopping) await setStatus(state, 'stopped');
        else if (!['conflict', 'unauthorized', 'error'].includes(state.status)) await setStatus(state, 'stopped');
      }
      logger.log('CUSTOMER BOT ' + state.id + ' runtime ended: ' + state.status);
    }
  }

  function activeTaskCount() {
    return Array.from(runningBots.values()).filter(state => Boolean(state.task)).length;
  }

  function startRecord(record) {
    const id = String(record.id);
    let state = runningBots.get(id);
    if (state && state.task) return state;
    if (activeTaskCount() >= maxBots) throw new Error('Maximum active customer bots reached (' + maxBots + ')');

    if (!state) {
      state = {
        id,
        bot: null,
        task: null,
        status: 'stopped',
        retryCount: 0,
        stopRequested: false,
        leaseLost: false,
        leaseLossNotified: false,
        retryTimer: null,
        wakeRetry: null,
        heartbeatTimer: null,
        lastErrorCode: null,
        lastErrorMessage: null
      };
      runningBots.set(id, state);
    }

    state.stopRequested = false;
    state.leaseLost = false;
    state.leaseLossNotified = false;
    runtimeStopping = false;
    state.task = runCustomerBot(record, state)
      .catch(error => {
        setStatus(state, 'error', error);
        logger.error('CUSTOMER BOT ' + id + ' RUNTIME FAILURE:', error.message);
      })
      .finally(() => {
        state.task = null;
      });
    return state;
  }

  async function startBotById(botId) {
    const id = String(botId);
    if (!/^\d+$/.test(id)) throw new TypeError('A valid bot id is required');
    const result = await pool.query(`
      SELECT id, name, username, token_ciphertext, token_iv, token_auth_tag
      FROM telegram_bots
      WHERE id = $1 AND active = TRUE AND update_transport = 'polling' AND token_ciphertext IS NOT NULL
      LIMIT 1
    `, [id]);
    if (!result.rowCount) throw new Error('Bot not found, inactive, missing encrypted token, or not configured for polling');
    return startRecord(result.rows[0]);
  }

  async function stopBotById(botId) {
    const id = String(botId);
    const state = runningBots.get(id);
    if (!state) return { id, status: 'stopped', wasRunning: false };
    state.stopRequested = true;
    if (state.wakeRetry) state.wakeRetry();
    if (state.bot) {
      try { await state.bot.stop(); }
      catch (error) { logger.error('CUSTOMER BOT STOP ERROR ' + id + ':', error.message); }
    }
    if (state.task) await state.task;
    await setStatus(state, 'stopped');
    return { id, status: state.status, wasRunning: true };
  }

  async function startBotRuntime() {
    runtimeStopping = false;
    const result = await pool.query(`
      SELECT id, name, username, token_ciphertext, token_iv, token_auth_tag
      FROM telegram_bots
      WHERE active = TRUE AND update_transport = 'polling' AND token_ciphertext IS NOT NULL
      ORDER BY id ASC
    `);
    const records = result.rows;
    logger.log('Customer bots found: ' + records.length);
    const accepted = records.slice(0, maxBots);
    for (const record of accepted) startRecord(record);
    if (records.length > maxBots) {
      logger.error('CUSTOMER BOT CAPACITY LIMIT: ' + records.length + ' active records found; only first ' + maxBots + ' were started.');
    }
    return { found: records.length, started: accepted.length, capacity: maxBots };
  }

  async function stopBotRuntime() {
    runtimeStopping = true;
    const states = Array.from(runningBots.values());
    await Promise.allSettled(states.map(state => stopBotById(state.id)));
    runningBots.clear();
  }

  function getRunningBotCount() {
    return Array.from(runningBots.values()).filter(state => state.status === 'running').length;
  }

  function getBotRuntimeStatus(botId) {
    const state = runningBots.get(String(botId));
    return state ? state.status : 'not_loaded';
  }

  function getRuntimeSnapshot() {
    return Array.from(runningBots.values()).map(state => ({
      id: state.id,
      status: state.status,
      retryCount: state.retryCount,
      lastErrorCode: state.lastErrorCode,
      lastErrorMessage: state.lastErrorMessage,
      running: state.status === 'running',
      leaseLost: state.leaseLost
    }));
  }

  return {
    startBotRuntime,
    stopBotRuntime,
    startBotById,
    stopBotById,
    getRunningBotCount,
    getBotRuntimeStatus,
    getRuntimeSnapshot
  };
}

let defaultRuntime = null;

function getDefaultRuntime() {
  if (!defaultRuntime) {
    const { pool, decryptToken } = require('./db');
    const { createCustomerBot } = require('./customer-bot');
    defaultRuntime = createBotRuntime({ pool, decryptToken, createCustomerBot });
  }
  return defaultRuntime;
}

module.exports = {
  createBotRuntime,
  startBotRuntime: (...args) => getDefaultRuntime().startBotRuntime(...args),
  stopBotRuntime: (...args) => getDefaultRuntime().stopBotRuntime(...args),
  startBotById: (...args) => getDefaultRuntime().startBotById(...args),
  stopBotById: (...args) => getDefaultRuntime().stopBotById(...args),
  getRunningBotCount: (...args) => getDefaultRuntime().getRunningBotCount(...args),
  getBotRuntimeStatus: (...args) => getDefaultRuntime().getBotRuntimeStatus(...args),
  getRuntimeSnapshot: (...args) => getDefaultRuntime().getRuntimeSnapshot(...args)
};
