'use strict';

const { evaluateAutoRemediation, DEFAULT_WINDOW_MS } = require('./auto-remediation-policy');

function createAutoRemediator({
  pool,
  staleAfterSeconds = 90,
  now = () => Date.now()
}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 30) {
    throw new RangeError('staleAfterSeconds must be at least 30 seconds');
  }

  async function consider(botId) {
    if (!/^[1-9]\d*$/.test(String(botId || ''))) {
      return { eligible: false, reason: 'invalid_bot_id' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(`
        SELECT b.id, b.active, b.token_ciphertext,
               s.status, s.last_heartbeat_at
        FROM telegram_bots b
        LEFT JOIN bot_runtime_status s ON s.bot_id = b.id
        WHERE b.id = $1
        FOR UPDATE OF b
      `, [String(botId)]);

      if (!found.rowCount) {
        await client.query('COMMIT');
        return { eligible: false, reason: 'bot_not_found' };
      }

      const bot = found.rows[0];
      const heartbeatAt = bot.last_heartbeat_at ? new Date(bot.last_heartbeat_at).getTime() : 0;
      const isStale = heartbeatAt > 0 && now() - heartbeatAt > staleAfterSeconds * 1000;
      let reason = 'manual_intervention_required';
      if (bot.status === 'running' && isStale) reason = 'stale_heartbeat';
      else if (bot.status === 'stopped') reason = 'unexpectedly_stopped';
      else if (!bot.status || !heartbeatAt) reason = 'missing_heartbeat';

      const history = await client.query(`
        SELECT status, requested_at AS at
        FROM bot_auto_remediation_attempts
        WHERE bot_id = $1
          AND requested_at >= NOW() - ($2::bigint * INTERVAL '1 millisecond')
        ORDER BY requested_at DESC
      `, [String(botId), DEFAULT_WINDOW_MS]);

      const decision = evaluateAutoRemediation({
        botId: String(bot.id),
        active: bot.active === true,
        hasEncryptedToken: Boolean(bot.token_ciphertext),
        reason,
        status: bot.status || 'unknown'
      }, history.rows, { now: now() });

      if (!decision.eligible) {
        await client.query('COMMIT');
        return decision;
      }

      const attempt = await client.query(`
        INSERT INTO bot_auto_remediation_attempts
          (bot_id, status, reason, requested_at)
        VALUES ($1, 'queued', $2, NOW())
        RETURNING id
      `, [String(botId), reason]);

      const command = await client.query(`
        INSERT INTO bot_runtime_commands
          (bot_id, action, status, requested_by, auto_remediation_attempt_id)
        VALUES ($1, 'restart', 'queued', 'auto-remediation', $2)
        RETURNING id
      `, [String(botId), attempt.rows[0].id]);

      await client.query(`
        UPDATE bot_auto_remediation_attempts
        SET command_id = $2
        WHERE id = $1
      `, [attempt.rows[0].id, command.rows[0].id]);

      await client.query('COMMIT');
      return {
        eligible: true,
        queued: true,
        action: 'restart',
        attemptId: String(attempt.rows[0].id),
        commandId: String(command.rows[0].id),
        attempt: decision.attempt
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error && error.code === '23505') {
        return { eligible: false, reason: 'remediation_already_pending' };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return { consider };
}

module.exports = { createAutoRemediator };
