'use strict';

const { createCustomerBot } = require('./customer-bot');

function createTelegramUpdateHandler({
  pool,
  decryptToken,
  botFactory,
  leaseSeconds = 120
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (typeof decryptToken !== 'function') throw new TypeError('decryptToken(record) is required');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) throw new RangeError('leaseSeconds must be at least 10');

  const makeBot = botFactory || createCustomerBot;
  const initializedBots = new Map();

  async function getInitializedBot(record, token) {
    const id = String(record.id);
    const cached = initializedBots.get(id);
    if (cached && cached.token === token) {
      await cached.initializing;
      return cached.bot;
    }

    const bot = makeBot(record, token);
    if (!bot || typeof bot.init !== 'function' || typeof bot.handleUpdate !== 'function') {
      throw new TypeError('Customer bot must provide grammY init() and handleUpdate() methods');
    }

    const entry = { token, bot, initializing: null };
    entry.initializing = Promise.resolve().then(() => bot.init());
    initializedBots.set(id, entry);
    try {
      await entry.initializing;
      return bot;
    } catch (error) {
      if (initializedBots.get(id) === entry) initializedBots.delete(id);
      throw error;
    }
  }

  return async function handleTelegramUpdate(job, context = {}) {
    const botId = Number(job.payload?.botId);
    const updateId = Number(job.payload?.updateId);
    const workerId = context.workerId || job.locked_by;
    const activeLeaseSeconds = context.leaseSeconds ?? leaseSeconds;
    const jobId = job.id;
    if (!Number.isSafeInteger(botId) || botId < 1 || !Number.isSafeInteger(updateId) || updateId < 0) {
      throw new Error('Invalid Telegram update job payload');
    }
    if ((typeof workerId !== 'string' || !workerId) || jobId === undefined || jobId === null) {
      throw new Error('Telegram update job lease identity is required');
    }

    const claimed = await pool.query(`
      UPDATE bot_inbound_updates AS inbound
      SET state = 'processing',
          attempts = attempts + 1,
          locked_at = NOW(),
          locked_by = $4,
          last_error = NULL
      FROM telegram_bots AS bot
      WHERE inbound.bot_id = $1
        AND inbound.update_id = $2
        AND bot.id = inbound.bot_id
        AND bot.active = TRUE
        AND bot.update_transport = 'webhook'
        AND (
          inbound.state IN ('queued', 'failed')
          OR (
            inbound.state = 'processing'
            AND inbound.locked_at < NOW() - make_interval(secs => $3::int)
          )
        )
        AND EXISTS (
          SELECT 1 FROM platform_jobs AS active_job
          WHERE active_job.id = $5
            AND active_job.job_type = 'telegram.update'
            AND active_job.status = 'processing'
            AND active_job.locked_by = $4
            AND active_job.locked_at >= NOW() - make_interval(secs => $3::int)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM bot_inbound_updates AS earlier
          LEFT JOIN platform_jobs AS earlier_job
            ON earlier_job.job_type = 'telegram.update'
           AND earlier_job.idempotency_key =
             'telegram.update:' || earlier.bot_id::text || ':' || earlier.update_id::text
          WHERE earlier.bot_id = inbound.bot_id
            AND earlier.update_id < inbound.update_id
            AND earlier.state <> 'processed'
            AND COALESCE(earlier_job.status, 'queued') <> 'dead_letter'
        )
      RETURNING inbound.payload, bot.id, bot.name,
                bot.token_ciphertext, bot.token_iv, bot.token_auth_tag
    `, [botId, updateId, activeLeaseSeconds, workerId, jobId]);

    if (!claimed.rowCount) {
      const current = await pool.query(
        'SELECT state FROM bot_inbound_updates WHERE bot_id = $1 AND update_id = $2',
        [botId, updateId]
      );
      if (current.rows[0]?.state === 'processed') return { duplicate: true };
      throw new Error('Telegram update is already leased, blocked by an earlier update, or unavailable');
    }

    const record = claimed.rows[0];
    let leaseLost = false;
    let heartbeatInFlight = null;
    const heartbeatIntervalMs = Math.max(1000, Math.floor(activeLeaseSeconds * 1000 / 3));

    async function renewInboxLease() {
      const renewed = await pool.query(`
        UPDATE bot_inbound_updates AS inbound
        SET locked_at = NOW()
        WHERE inbound.bot_id = $1
          AND inbound.update_id = $2
          AND inbound.state = 'processing'
          AND inbound.locked_by = $3
          AND EXISTS (
            SELECT 1 FROM platform_jobs AS active_job
            WHERE active_job.id = $4
              AND active_job.job_type = 'telegram.update'
              AND active_job.status = 'processing'
              AND active_job.locked_by = $3
              AND active_job.locked_at >= NOW() - make_interval(secs => $5::int)
          )
        RETURNING inbound.id
      `, [botId, updateId, workerId, jobId, activeLeaseSeconds]);
      if (!renewed.rowCount) leaseLost = true;
    }

    const heartbeat = setInterval(() => {
      if (heartbeatInFlight || leaseLost ||
          (typeof context.isLeaseLost === 'function' && context.isLeaseLost())) return;
      heartbeatInFlight = renewInboxLease()
        .catch(() => { leaseLost = true; })
        .finally(() => { heartbeatInFlight = null; });
    }, heartbeatIntervalMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const hasLostLease = () => leaseLost ||
      (typeof context.isLeaseLost === 'function' && context.isLeaseLost());

    try {
      if (hasLostLease()) throw new Error('Telegram update queue lease was lost before handling');
      const token = decryptToken(record);
      const bot = await getInitializedBot(record, token);
      if (hasLostLease()) throw new Error('Telegram update queue lease was lost before dispatch');
      await bot.handleUpdate(record.payload);

      clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (hasLostLease()) throw new Error('Telegram update lease was lost during handling');

      const saved = await pool.query(`
        UPDATE bot_inbound_updates AS inbound
        SET state = 'processed',
            processed_at = NOW(),
            locked_at = NULL,
            locked_by = NULL,
            last_error = NULL
        WHERE inbound.bot_id = $1
          AND inbound.update_id = $2
          AND inbound.state = 'processing'
          AND inbound.locked_by = $3
          AND EXISTS (
            SELECT 1 FROM platform_jobs AS active_job
            WHERE active_job.id = $4
              AND active_job.job_type = 'telegram.update'
              AND active_job.status = 'processing'
              AND active_job.locked_by = $3
              AND active_job.locked_at >= NOW() - make_interval(secs => $5::int)
          )
        RETURNING inbound.id
      `, [botId, updateId, workerId, jobId, activeLeaseSeconds]);
      if (!saved.rowCount) throw new Error('Telegram update lease was lost before completion');
      return { processed: true, botId, updateId };
    } catch (error) {
      clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (!hasLostLease()) {
        try {
          await pool.query(`
            UPDATE bot_inbound_updates AS inbound
            SET state = 'failed',
                locked_at = NULL,
                locked_by = NULL,
                last_error = LEFT($5, 4000)
            WHERE inbound.bot_id = $1
              AND inbound.update_id = $2
              AND inbound.state = 'processing'
              AND inbound.locked_by = $3
              AND EXISTS (
                SELECT 1 FROM platform_jobs AS active_job
                WHERE active_job.id = $4
                  AND active_job.job_type = 'telegram.update'
                  AND active_job.status = 'processing'
                  AND active_job.locked_by = $3
                  AND active_job.locked_at >= NOW() - make_interval(secs => $6::int)
              )
          `, [botId, updateId, workerId, jobId, String(error.message || error), activeLeaseSeconds]);
        } catch (_) {}
      }
      throw error;
    }
  };
}

module.exports = { createTelegramUpdateHandler };
