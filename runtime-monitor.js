'use strict';

const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_STALE_AFTER_SECONDS = 90;

function createRuntimeMonitor({
  pool,
  intervalMs = DEFAULT_INTERVAL_MS,
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
  logger = console,
  now = () => Date.now(),
  autoRemediator = null,
  autoRemediationEnabled = false
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new RangeError('intervalMs must be at least 1000ms');
  if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 30) throw new RangeError('staleAfterSeconds must be at least 30 seconds');

  let timer = null;
  let stopped = true;

  async function pollOnce() {
    const [result, workerResult] = await Promise.all([
      pool.query(`
        SELECT b.id, b.name, s.status, s.worker_id,
               s.last_heartbeat_at, s.last_error_code
        FROM telegram_bots b
        LEFT JOIN bot_runtime_status s ON s.bot_id = b.id
        WHERE b.active = TRUE AND b.token_ciphertext IS NOT NULL
        ORDER BY b.id ASC
      `),
      pool.query(`
        SELECT worker_id, status, capacity, last_heartbeat_at
        FROM bot_worker_status
        ORDER BY worker_id ASC
      `)
    ]);
    const currentTime = now();
    const issues = [];

    for (const row of result.rows) {
      const heartbeat = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0;
      const fresh = heartbeat > 0 && currentTime - heartbeat <= staleAfterSeconds * 1000;
      let reason = null;

      if (!row.status || !heartbeat) reason = 'missing_heartbeat';
      else if (!fresh) reason = 'stale_heartbeat';
      else if (row.status === 'error' || row.status === 'conflict' || row.status === 'unauthorized') reason = row.status;
      else if (row.status === 'retrying') reason = 'retrying';
      else if (row.status === 'stopped') reason = 'unexpectedly_stopped';

      if (reason) {
        issues.push({
          botId: String(row.id),
          botName: row.name,
          status: row.status || 'unknown',
          workerId: row.worker_id || null,
          reason,
          errorCode: row.last_error_code || null
        });
      }
    }

    return {
      checkedAt: new Date(currentTime).toISOString(),
      activeBots: result.rows.length,
      healthyBots: result.rows.length - issues.length,
      workers: workerResult.rows.map(worker => {
        const heartbeat = worker.last_heartbeat_at ? new Date(worker.last_heartbeat_at).getTime() : 0;
        const fresh = heartbeat > 0 && currentTime - heartbeat <= staleAfterSeconds * 1000;
        return {
          workerId: worker.worker_id,
          status: worker.status,
          capacity: worker.capacity,
          lastHeartbeatAt: worker.last_heartbeat_at,
          health: worker.status !== 'running' ? 'stopped' : (fresh ? 'healthy' : 'stale_heartbeat')
        };
      }),
      issues
    };
  }

  async function check() {
    const report = await pollOnce();
    if (report.issues.length) {
      logger.error('BOSS RUNTIME HEALTH: ' + report.issues.length + ' issue(s) across ' +
        report.activeBots + ' active bot(s).', report.issues);
    } else {
      logger.log('BOSS RUNTIME HEALTH OK: ' + report.healthyBots + '/' + report.activeBots +
        ' active bot(s), ' + report.workers.length + ' worker(s) observed.');
    }

    report.remediation = [];
    if (autoRemediationEnabled && autoRemediator) {
      for (const issue of report.issues) {
        try {
          const result = await autoRemediator.consider(issue.botId);
          report.remediation.push({ botId: issue.botId, ...result });
        } catch (error) {
          logger.error('AUTO REMEDIATION DECISION FAILED FOR BOT ' + issue.botId + ':', error.message);
          report.remediation.push({
            botId: issue.botId,
            eligible: false,
            reason: 'remediation_service_error'
          });
        }
      }
    }
    return report;
  }

  async function start() {
    if (!stopped) return;
    stopped = false;
    const loop = async () => {
      if (stopped) return;
      try { await check(); }
      catch (error) { logger.error('RUNTIME HEALTH CHECK FAILED:', error.message); }
      if (!stopped) timer = setTimeout(loop, intervalMs);
    };
    await loop();
  }

  async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { pollOnce, check, start, stop };
}

async function main() {
  require('dotenv').config();
  const databaseUrl = require('./database-config').getDatabaseUrl(process.env);
  const { getPostgresSslConfig } = require('./postgres-ssl');
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: getPostgresSslConfig(),
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  const autoRemediationEnabled = process.env.AUTO_REMEDIATION_ENABLED === 'YES';
  const autoRemediator = autoRemediationEnabled
    ? require('./auto-remediation').createAutoRemediator({
        pool,
        staleAfterSeconds: Number(process.env.RUNTIME_MONITOR_STALE_SECONDS || DEFAULT_STALE_AFTER_SECONDS)
      })
    : null;
  if (autoRemediationEnabled) {
    console.log('AUTO REMEDIATION ENABLED: safe restart policy, durable audit, cooldown and attempt limits active.');
  } else {
    console.log('AUTO REMEDIATION DISABLED: monitor is read-only.');
  }
  const monitor = createRuntimeMonitor({
    pool,
    intervalMs: Number(process.env.RUNTIME_MONITOR_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    staleAfterSeconds: Number(process.env.RUNTIME_MONITOR_STALE_SECONDS || DEFAULT_STALE_AFTER_SECONDS),
    autoRemediator,
    autoRemediationEnabled
  });
  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    console.log('Runtime monitor stopping:', signal);
    await monitor.stop();
    await pool.end();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
    console.error('Runtime monitor shutdown failed:', error.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
    console.error('Runtime monitor shutdown failed:', error.message);
    process.exitCode = 1;
  }));
  await monitor.start();
}

if (require.main === module) {
  main().catch(error => {
    console.error('RUNTIME MONITOR STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { createRuntimeMonitor, main };
