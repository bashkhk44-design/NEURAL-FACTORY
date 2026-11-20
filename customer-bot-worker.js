'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_CAPACITY = 25;
const DEFAULT_LEASE_SECONDS = 90;

async function claimNextBot(pool, workerId, leaseSeconds = DEFAULT_LEASE_SECONDS, requestedBotId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query(`
      SELECT b.id
      FROM telegram_bots b
      LEFT JOIN bot_runtime_status s ON s.bot_id = b.id
      WHERE b.active = TRUE
        AND b.token_ciphertext IS NOT NULL
        AND b.update_transport = 'polling'
        AND ($2::bigint IS NULL OR b.id = $2::bigint)
        AND (
          s.bot_id IS NULL
          OR s.status IN ('unknown', 'stopped', 'error')
          OR s.last_heartbeat_at IS NULL
          OR s.last_heartbeat_at < NOW() - ($1::int * INTERVAL '1 second')
        )
      ORDER BY b.id ASC
      FOR UPDATE OF b SKIP LOCKED
      LIMIT 1
    `, [leaseSeconds, requestedBotId]);
    if (!candidate.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const botId = String(candidate.rows[0].id);
    const ownership = await client.query(`
      INSERT INTO bot_runtime_status
        (bot_id, status, worker_id, last_heartbeat_at, updated_at)
      VALUES ($1, 'starting', $2, NOW(), NOW())
      ON CONFLICT (bot_id) DO UPDATE SET
        status = 'starting',
        worker_id = EXCLUDED.worker_id,
        last_heartbeat_at = NOW(),
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = NOW()
      WHERE bot_runtime_status.worker_id = EXCLUDED.worker_id
        OR bot_runtime_status.status IN ('unknown', 'stopped', 'error')
        OR bot_runtime_status.last_heartbeat_at IS NULL
        OR bot_runtime_status.last_heartbeat_at < NOW() - ($3::int * INTERVAL '1 second')
      RETURNING bot_id
    `, [botId, workerId, leaseSeconds]);
    if (!ownership.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    await client.query('COMMIT');
    return botId;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function createCustomerBotWorker({
  pool,
  runtime,
  workerId = randomUUID(),
  capacity = DEFAULT_CAPACITY,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  pollIntervalMs = 3000,
  botReadyTimeoutMs = 30000,
  botReadyPollMs = 1000,
  logger = console
}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (!runtime || typeof runtime.startBotById !== 'function') throw new TypeError('Bot runtime is required');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw new RangeError('capacity must be between 1 and 100');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30) throw new RangeError('leaseSeconds must be at least 30 seconds');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 500) throw new RangeError('pollIntervalMs must be at least 500ms');
  if (!Number.isInteger(botReadyTimeoutMs) || botReadyTimeoutMs < 1000) throw new RangeError('botReadyTimeoutMs must be at least 1000ms');
  if (!Number.isInteger(botReadyPollMs) || botReadyPollMs < 100) throw new RangeError('botReadyPollMs must be at least 100ms');

  let stopping = false;
  let loopPromise = null;

  async function claimNextCommand() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        SELECT c.id, c.bot_id, c.action, c.target_worker_id, c.auto_remediation_attempt_id
        FROM bot_runtime_commands c
        WHERE (
            c.status = 'queued'
            OR (c.status = 'processing' AND (c.claimed_at IS NULL OR c.claimed_at < NOW() - ($2::int * INTERVAL '1 second')))
          )
          AND (
            c.target_worker_id IS NULL
            OR c.target_worker_id = $1
            OR NOT EXISTS (
              SELECT 1 FROM bot_runtime_status owner_status
              WHERE owner_status.bot_id = c.bot_id
                AND owner_status.worker_id = c.target_worker_id
                AND owner_status.last_heartbeat_at >= NOW() - ($2::int * INTERVAL '1 second')
            )
          )
        ORDER BY c.id ASC
        FOR UPDATE OF c SKIP LOCKED
        LIMIT 1
      `, [workerId, leaseSeconds]);
      if (!result.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const command = result.rows[0];
      await client.query(`
        UPDATE bot_runtime_commands
        SET status = 'processing', claimed_by = $2, claimed_at = NOW(), attempts = attempts + 1
        WHERE id = $1
      `, [command.id, workerId]);
      await client.query(`
        UPDATE bot_auto_remediation_attempts
        SET status = 'processing', started_at = COALESCE(started_at, NOW())
        WHERE id = (
          SELECT auto_remediation_attempt_id
          FROM bot_runtime_commands WHERE id = $1
        ) AND status = 'queued'
      `, [command.id]);
      await client.query('COMMIT');
      return command;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function processNextCommand() {
    const command = await claimNextCommand();
    if (!command) return false;
    const botId = String(command.bot_id);
    let commandLeaseLost = false;
    let commandHeartbeatBusy = false;
    let commandHeartbeatPromise = Promise.resolve();
    const commandHeartbeatIntervalMs = Math.max(1000, Math.floor(leaseSeconds * 1000 / 3));
    const commandHeartbeat = setInterval(() => {
      if (commandHeartbeatBusy || commandLeaseLost) return;
      commandHeartbeatBusy = true;
      commandHeartbeatPromise = (async () => {
        try {
          const renewed = await pool.query(`
            UPDATE bot_runtime_commands
            SET claimed_at = NOW()
            WHERE id = $1 AND claimed_by = $2 AND status = 'processing'
              AND claimed_at >= NOW() - ($3::int * INTERVAL '1 second')
            RETURNING id
          `, [command.id, workerId, leaseSeconds]);
          if (!renewed.rowCount) commandLeaseLost = true;
        } catch (error) {
          commandLeaseLost = true;
          logger.error('Could not renew manager command lease ' + command.id + ': ' + error.message);
        } finally {
          commandHeartbeatBusy = false;
        }
      })();
    }, commandHeartbeatIntervalMs);
    if (typeof commandHeartbeat.unref === 'function') commandHeartbeat.unref();
    const assertCommandLease = () => {
      if (commandLeaseLost) throw new Error('Manager command lease was lost before completion');
    };
    try {
      if (command.action === 'stop' || command.action === 'restart') {
        await runtime.stopBotById(botId);
        assertCommandLease();
        await pool.query(`
          UPDATE bot_runtime_status
          SET status = 'stopped', worker_id = NULL,
              last_heartbeat_at = NOW(), updated_at = NOW()
          WHERE bot_id = $1
            AND (worker_id = $2 OR worker_id = $3 OR last_heartbeat_at < NOW() - ($4::int * INTERVAL '1 second') OR worker_id IS NULL)
        `, [botId, workerId, command.target_worker_id, leaseSeconds]);
        assertCommandLease();
      }
      if (command.action === 'start' || command.action === 'restart') {
        const claimedBotId = await claimNextBot(pool, workerId, leaseSeconds, botId);
        assertCommandLease();
        if (claimedBotId) {
          await runtime.startBotById(claimedBotId);
          assertCommandLease();
          if (command.auto_remediation_attempt_id) {
            const deadline = Date.now() + botReadyTimeoutMs;
            let healthy = false;
            while (Date.now() < deadline) {
              assertCommandLease();
              const statusResult = await pool.query(`
                SELECT status, worker_id, last_heartbeat_at
                FROM bot_runtime_status
                WHERE bot_id = $1
              `, [botId]);
              assertCommandLease();
              const status = statusResult.rows[0];
              const heartbeatAt = status?.last_heartbeat_at
                ? new Date(status.last_heartbeat_at).getTime()
                : 0;
              healthy = status?.status === 'running' &&
                status.worker_id === workerId &&
                heartbeatAt > 0 &&
                Date.now() - heartbeatAt <= leaseSeconds * 1000;
              if (healthy) break;
              await new Promise(resolve => setTimeout(resolve, botReadyPollMs));
            }
            if (!healthy) {
              try { await runtime.stopBotById(botId); } catch (_) {}
              throw new Error('Automatic restart did not reach a healthy running state before timeout');
            }
          }
        } else {
          const owner = await pool.query(
            'SELECT worker_id, last_heartbeat_at FROM bot_runtime_status WHERE bot_id = $1',
            [botId]
          );
          assertCommandLease();
          const status = owner.rows[0];
          const ownedHere = status?.worker_id === workerId;
          const ownerFresh = status?.last_heartbeat_at &&
            Date.now() - new Date(status.last_heartbeat_at).getTime() < leaseSeconds * 1000;
          if (ownedHere && ownerFresh) {
            await runtime.startBotById(botId);
            assertCommandLease();
          } else {
            throw new Error('تعذر حجز البوت بأمان؛ قد يكون عاملاً آخر يملكه حالياً.');
          }
        }
      }
      clearInterval(commandHeartbeat);
      await commandHeartbeatPromise;
      assertCommandLease();
      const completed = await pool.query(`
        UPDATE bot_runtime_commands
        SET status = 'completed', processed_at = NOW(), error_message = NULL
        WHERE id = $1 AND claimed_by = $2 AND status = 'processing'
          AND claimed_at >= NOW() - ($3::int * INTERVAL '1 second')
        RETURNING auto_remediation_attempt_id
      `, [command.id, workerId, leaseSeconds]);
      if (!completed.rowCount) throw new Error('Manager command lease was lost before completion');
      if (completed.rows[0].auto_remediation_attempt_id) {
        await pool.query(`
          UPDATE bot_auto_remediation_attempts
          SET status = 'succeeded', finished_at = NOW(), error_message = NULL
          WHERE id = $1 AND status IN ('queued','processing')
        `, [completed.rows[0].auto_remediation_attempt_id]);
      }
      logger.log('Processed manager command ' + command.action + ' for bot ' + botId);
    } catch (error) {
      clearInterval(commandHeartbeat);
      await commandHeartbeatPromise;
      if (commandLeaseLost && (command.action === 'start' || command.action === 'restart')) {
        try { await runtime.stopBotById(botId); }
        catch (stopError) { logger.error('Could not stop bot after manager command lease loss ' + botId + ': ' + stopError.message); }
      }
      const failed = await pool.query(`
        UPDATE bot_runtime_commands
        SET status = 'failed', processed_at = NOW(), error_message = $3
        WHERE id = $1 AND claimed_by = $2 AND status = 'processing'
          AND claimed_at >= NOW() - ($4::int * INTERVAL '1 second')
        RETURNING auto_remediation_attempt_id
      `, [command.id, workerId, String(error.message || error).slice(0, 1000), leaseSeconds]);
      if (failed.rowCount && failed.rows[0].auto_remediation_attempt_id) {
        await pool.query(`
          UPDATE bot_auto_remediation_attempts
          SET status = 'failed', finished_at = NOW(), error_message = $2
          WHERE id = $1 AND status IN ('queued','processing')
        `, [failed.rows[0].auto_remediation_attempt_id, String(error.message || error).slice(0, 1000)]);
      }
      if (failed.rowCount) logger.error('Manager command failed for bot ' + botId + ': ' + error.message);
      else logger.error('Manager command ' + command.id + ' was no longer owned by worker ' + workerId + '; stale result ignored');
    } finally {
      clearInterval(commandHeartbeat);
      await commandHeartbeatPromise;
    }
    return true;
  }

  async function runOnce() {
    if (await processNextCommand()) return true;
    const snapshot = runtime.getRuntimeSnapshot();
    const owned = snapshot.filter(item => item.status !== 'stopped' && item.status !== 'error' && item.status !== 'conflict' && item.status !== 'unauthorized').length;
    if (owned >= capacity) return false;

    const botId = await claimNextBot(pool, workerId, leaseSeconds);
    if (!botId) return false;
    try {
      await runtime.startBotById(botId);
      logger.log('Customer bot assigned to worker ' + workerId + ': ' + botId);
      return true;
    } catch (error) {
      await pool.query(`
        UPDATE bot_runtime_status
        SET status = 'error', worker_id = $2,
            last_error_code = 'WORKER_START_FAILED',
            last_error_message = $3,
            last_heartbeat_at = NOW(), updated_at = NOW()
        WHERE bot_id = $1 AND worker_id = $2
      `, [botId, workerId, String(error.message || error).slice(0, 1000)]);
      logger.error('Could not start customer bot ' + botId + ': ' + error.message);
      return true;
    }
  }

  async function publishWorkerHeartbeat(status) {
    await pool.query(`
      INSERT INTO bot_worker_status (worker_id, status, capacity, last_heartbeat_at, started_at, stopped_at)
      VALUES ($1, $2, $3, NOW(), CASE WHEN $2 = 'running' THEN NOW() ELSE NULL END,
        CASE WHEN $2 = 'stopped' THEN NOW() ELSE NULL END)
      ON CONFLICT (worker_id) DO UPDATE SET
        status = EXCLUDED.status,
        capacity = EXCLUDED.capacity,
        last_heartbeat_at = NOW(),
        started_at = CASE WHEN EXCLUDED.status = 'running' AND bot_worker_status.status <> 'running'
          THEN NOW() ELSE bot_worker_status.started_at END,
        stopped_at = CASE WHEN EXCLUDED.status = 'stopped' THEN NOW() ELSE NULL END,
        updated_at = NOW()
    `, [workerId, status, capacity]);
  }

  async function run() {
    try {
      await publishWorkerHeartbeat('running');
      while (!stopping) {
        try {
          await publishWorkerHeartbeat('running');
        const didWork = await runOnce();
        if (!didWork && !stopping) await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      } catch (error) {
        logger.error('Customer bot worker loop error:', error.message);
        if (!stopping) await new Promise(resolve => setTimeout(resolve, Math.max(pollIntervalMs, 5000)));
        }
      }
    } finally {
      try { await publishWorkerHeartbeat('stopped'); }
      catch (error) { logger.error('Could not publish worker shutdown status:', error.message); }
    }
  }

  return {
    workerId,
    runOnce,
    start() {
      if (loopPromise) return loopPromise;
      stopping = false;
      loopPromise = run().finally(() => { loopPromise = null; });
      return loopPromise;
    },
    async stop() {
      stopping = true;
      if (loopPromise) {
        // Wake a sleeping poll loop; its bounded delay is at most 5 seconds.
        await loopPromise;
      }
      await runtime.stopBotRuntime();
    }
  };
}

async function main() {
  if (process.env.CUSTOMER_BOT_WORKER_ENABLED !== 'YES') {
    throw new Error('Set CUSTOMER_BOT_WORKER_ENABLED=YES only on a dedicated test/worker service');
  }
  const databaseUrl = require('./database-config').getDatabaseUrl(process.env);
  const { getPostgresSslConfig } = require('./postgres-ssl');
  const { Pool } = require('pg');
  const { decryptToken } = require('./db');
  const { createCustomerBot } = require('./customer-bot');
  const { createBotRuntime } = require('./bot-runtime');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: getPostgresSslConfig(),
    max: Number(process.env.WORKER_DB_POOL_MAX || 3),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  const workerId = (process.env.CUSTOMER_BOT_WORKER_ID
    ? process.env.CUSTOMER_BOT_WORKER_ID + ':'
    : '') + randomUUID();
  let worker = null;
  const leaseSeconds = Number(process.env.CUSTOMER_BOT_LEASE_SECONDS || DEFAULT_LEASE_SECONDS);
  const runtime = createBotRuntime({
    pool,
    decryptToken,
    createCustomerBot,
    workerId,
    requireLease: true,
    leaseSeconds,
    heartbeatIntervalMs: Math.max(1000, Math.floor(leaseSeconds * 1000 / 3)),
    maxBots: Number(process.env.CUSTOMER_BOT_WORKER_CAPACITY || DEFAULT_CAPACITY),
    onLeaseLost: botId => console.error('Customer bot lease lost; local bot stopped:', botId),
    onStatusPersistError: error => {
      console.error('WORKER LEASE HEARTBEAT LOST; stopping owned bots:', error.message);
      if (worker) void worker.stop();
      else void runtime.stopBotRuntime();
    }
  });
  worker = createCustomerBotWorker({
    pool,
    runtime,
    workerId,
    capacity: Number(process.env.CUSTOMER_BOT_WORKER_CAPACITY || DEFAULT_CAPACITY),
    leaseSeconds,
    pollIntervalMs: Number(process.env.CUSTOMER_BOT_WORKER_POLL_MS || 3000)
  });
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    console.log('Customer bot worker stopping:', signal);
    try { await worker.stop(); } finally { await pool.end(); }
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
    console.error('Worker shutdown error:', error.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
    console.error('Worker shutdown error:', error.message);
    process.exitCode = 1;
  }));
  console.log('Customer bot worker started:', workerId, 'capacity:', worker.capacity || process.env.CUSTOMER_BOT_WORKER_CAPACITY || DEFAULT_CAPACITY);
  await worker.start();
}

if (require.main === module) {
  main().catch(error => {
    console.error('CUSTOMER BOT WORKER STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { claimNextBot, createCustomerBotWorker, main };
