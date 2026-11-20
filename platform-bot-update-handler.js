'use strict';

const JOB_TYPES = Object.freeze({
  master: 'telegram.master.update',
  intake: 'telegram.intake.update'
});

function createPlatformBotUpdateHandler({
  pool,
  runtimes,
  leaseSeconds = 120
}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('PostgreSQL pool is required');
  }
  if (!runtimes || typeof runtimes !== 'object') {
    throw new TypeError('Platform bot runtimes are required');
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) {
    throw new RangeError('leaseSeconds must be at least 10');
  }

  return async function handlePlatformBotUpdate(job, context = {}) {
    const identity = job?.payload?.botIdentity;
    const updateId = job?.payload?.updateId;
    const expectedJobType = JOB_TYPES[identity];
    const workerId = context.workerId;
    const activeLeaseSeconds = context.leaseSeconds || leaseSeconds;
    if (!Number.isInteger(activeLeaseSeconds) || activeLeaseSeconds < 10) {
      throw new RangeError('worker leaseSeconds must be at least 10');
    }

    if (!expectedJobType || job.job_type !== expectedJobType ||
        !Number.isSafeInteger(updateId) || updateId < 0 ||
        job.id === undefined || job.id === null ||
        typeof workerId !== 'string' || !workerId) {
      throw new Error('Invalid platform Telegram update job');
    }

    const runtime = runtimes[identity];
    if (!runtime || typeof runtime.handleUpdate !== 'function') {
      throw new Error('No webhook handler runtime is registered for ' + identity);
    }

    const heartbeatIntervalMs = context.leaseRenewalIntervalMs === undefined
      ? Math.max(1000, Math.floor(activeLeaseSeconds * 1000 / 3))
      : context.leaseRenewalIntervalMs;

    if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 100) {
      throw new RangeError('leaseRenewalIntervalMs must be at least 100ms');
    }

    const claimed = await pool.query(`
      UPDATE platform_bot_inbound_updates AS inbox
      SET state = 'processing',
          attempts = inbox.attempts + 1,
          locked_by = $3,
          locked_at = NOW(),
          last_error = NULL
      WHERE inbox.bot_identity = $1
        AND inbox.update_id = $2
        AND (
          inbox.state IN ('queued', 'failed')
          OR (
            inbox.state = 'processing'
            AND inbox.locked_at < NOW() - make_interval(secs => $6::int)
          )
        )
        AND EXISTS (
          SELECT 1 FROM platform_jobs AS job
          WHERE job.id = $4
            AND job.job_type = $5
            AND job.status = 'processing'
            AND job.locked_by = $3
            AND job.locked_at >= NOW() - make_interval(secs => $6::int)
        )
      RETURNING inbox.payload
    `, [identity, updateId, workerId, job.id, expectedJobType, activeLeaseSeconds]);

    if (!claimed.rowCount) {
      const current = await pool.query(
        'SELECT state FROM platform_bot_inbound_updates WHERE bot_identity = $1 AND update_id = $2',
        [identity, updateId]
      );
      if (current.rows[0]?.state === 'processed') return { duplicate: true, identity, updateId };
      throw new Error('Platform Telegram update is already leased or unavailable');
    }

    let inboxLeaseLost = false;
    let inboxHeartbeatInFlight = null;
    let inboxHeartbeatTimer = null;
    const isLeaseLost = () => inboxLeaseLost ||
      (typeof context.isLeaseLost === 'function' && context.isLeaseLost());

    async function renewInboxLease() {
      const renewed = await pool.query(`
        UPDATE platform_bot_inbound_updates AS inbox
        SET locked_at = NOW()
        WHERE inbox.bot_identity = $1
          AND inbox.update_id = $2
          AND inbox.state = 'processing'
          AND inbox.locked_by = $3
          AND EXISTS (
            SELECT 1 FROM platform_jobs AS job
            WHERE job.id = $4
              AND job.job_type = $5
              AND job.status = 'processing'
              AND job.locked_by = $3
              AND job.locked_at >= NOW() - make_interval(secs => $6::int)
          )
        RETURNING inbox.id
      `, [identity, updateId, workerId, job.id, expectedJobType, activeLeaseSeconds]);
      if (!renewed.rowCount) inboxLeaseLost = true;
    }

    try {
      if (isLeaseLost()) {
        throw new Error('Platform Telegram update queue lease was lost');
      }

      inboxHeartbeatTimer = setInterval(() => {
        if (inboxHeartbeatInFlight || isLeaseLost()) return;
        inboxHeartbeatInFlight = renewInboxLease()
          .catch(() => { inboxLeaseLost = true; })
          .finally(() => { inboxHeartbeatInFlight = null; });
      }, heartbeatIntervalMs);
      if (typeof inboxHeartbeatTimer.unref === 'function') inboxHeartbeatTimer.unref();

      await runtime.handleUpdate(claimed.rows[0].payload);

      clearInterval(inboxHeartbeatTimer);
      inboxHeartbeatTimer = null;
      if (inboxHeartbeatInFlight) await inboxHeartbeatInFlight;
      if (isLeaseLost()) {
        throw new Error('Platform Telegram update lease was lost during execution');
      }

      const saved = await pool.query(`
        UPDATE platform_bot_inbound_updates AS inbox
        SET state = 'processed',
            processed_at = NOW(),
            locked_by = NULL,
            locked_at = NULL,
            last_error = NULL
        WHERE inbox.bot_identity = $1
          AND inbox.update_id = $2
          AND inbox.state = 'processing'
          AND inbox.locked_by = $3
          AND EXISTS (
            SELECT 1 FROM platform_jobs AS job
            WHERE job.id = $4
              AND job.job_type = $5
              AND job.status = 'processing'
              AND job.locked_by = $3
              AND job.locked_at >= NOW() - make_interval(secs => $6::int)
          )
        RETURNING inbox.id
      `, [identity, updateId, workerId, job.id, expectedJobType, activeLeaseSeconds]);

      if (!saved.rowCount) {
        throw new Error('Platform Telegram update lease was lost before completion');
      }

      return { processed: true, identity, updateId };
    } catch (error) {
      if (inboxHeartbeatTimer) clearInterval(inboxHeartbeatTimer);
      if (inboxHeartbeatInFlight) await inboxHeartbeatInFlight;
      if (!isLeaseLost()) {
        try {
          await pool.query(`
            UPDATE platform_bot_inbound_updates AS inbox
            SET state = 'failed',
                locked_by = NULL,
                locked_at = NULL,
                last_error = LEFT($4, 4000)
            WHERE inbox.bot_identity = $1
              AND inbox.update_id = $2
              AND inbox.state = 'processing'
              AND inbox.locked_by = $3
              AND EXISTS (
                SELECT 1 FROM platform_jobs AS job
                WHERE job.id = $5
                  AND job.job_type = $6
                  AND job.status = 'processing'
                  AND job.locked_by = $3
                  AND job.locked_at >= NOW() - make_interval(secs => $7::int)
              )
          `, [
            identity, updateId, workerId, String(error.message || error),
            job.id, expectedJobType, activeLeaseSeconds
          ]);
        } catch (_) {}
      }
      throw error;
    }
  };
}

module.exports = { JOB_TYPES, createPlatformBotUpdateHandler };
