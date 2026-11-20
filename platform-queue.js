'use strict';

const MAX_ERROR_LENGTH = 4000;

function jsonValue(value, label) {
  if (value === undefined) return '{}';
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new TypeError(label + ' must be JSON serializable');
  }
}

async function enqueuePlatformJob(pool, {
  jobType,
  clientId = null,
  projectId = null,
  botId = null,
  idempotencyKey = null,
  payload = {},
  priority = 0,
  maxAttempts = 5,
  availableAt = null
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (typeof jobType !== 'string' || !/^[a-z][a-z0-9_.:-]{1,99}$/i.test(jobType)) {
    throw new TypeError('A valid jobType is required');
  }
  if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim())) {
    throw new TypeError('idempotencyKey must be null or a non-empty string');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new RangeError('maxAttempts must be between 1 and 20');
  }
  if (!Number.isInteger(priority) || priority < -32768 || priority > 32767) {
    throw new RangeError('priority must be a SMALLINT');
  }

  const result = await pool.query(`
    INSERT INTO platform_jobs
      (job_type, client_id, project_id, bot_id, idempotency_key,
       payload, priority, max_attempts, available_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8,
            COALESCE($9::timestamptz, NOW()))
    ON CONFLICT (job_type, idempotency_key) DO NOTHING
    RETURNING *
  `, [
    jobType, clientId, projectId, botId, idempotencyKey,
    jsonValue(payload, 'payload'), priority, maxAttempts, availableAt
  ]);

  if (result.rowCount) return { created: true, job: result.rows[0] };
  if (idempotencyKey === null) throw new Error('Job insert returned no row without an idempotency conflict');

  const existing = await pool.query(`
    SELECT * FROM platform_jobs
    WHERE job_type = $1 AND idempotency_key = $2
    LIMIT 1
  `, [jobType, idempotencyKey]);

  if (!existing.rowCount) throw new Error('Idempotent job conflict could not be resolved');
  return { created: false, job: existing.rows[0] };
}

function normalizeJobTypes(jobTypes) {
  if (jobTypes === undefined || jobTypes === null) throw new TypeError('jobTypes is required; unrestricted queue access is disabled');
  if (!Array.isArray(jobTypes) || jobTypes.length < 1 || jobTypes.length > 50) {
    throw new TypeError('jobTypes must be an array containing 1 to 50 registered job types');
  }
  const normalized = [...new Set(jobTypes)];
  for (const jobType of normalized) {
    if (typeof jobType !== 'string' || !/^[a-z][a-z0-9_.:-]{1,99}$/i.test(jobType)) {
      throw new TypeError('jobTypes contains an invalid job type');
    }
  }
  return normalized;
}

async function claimPlatformJob(pool, workerId, jobTypes) {
  if (!workerId || typeof workerId !== 'string') throw new TypeError('workerId is required');
  const allowedTypes = normalizeJobTypes(jobTypes);
  const result = await pool.query(`
        WITH candidate AS (
          SELECT id
          FROM platform_jobs
          WHERE status IN ('queued', 'retrying')
            AND available_at <= NOW()
            AND attempts < max_attempts
            AND (
              platform_jobs.job_type <> 'telegram.update'
              OR NOT EXISTS (
                SELECT 1
                FROM bot_inbound_updates AS earlier
                LEFT JOIN platform_jobs AS earlier_job
                  ON earlier_job.job_type = 'telegram.update'
                 AND earlier_job.idempotency_key =
                   'telegram.update:' || earlier.bot_id::text || ':' || earlier.update_id::text
                WHERE earlier.bot_id = platform_jobs.bot_id
                  AND earlier.update_id < (platform_jobs.payload->>'updateId')::bigint
                  AND earlier.state <> 'processed'
                  AND COALESCE(earlier_job.status, 'queued') <> 'dead_letter'
              )
            )
            AND job_type = ANY($2::text[])
          ORDER BY priority DESC, available_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE platform_jobs AS job
        SET status = 'processing',
            attempts = job.attempts + 1,
            locked_by = $1,
            locked_at = NOW(),
            updated_at = NOW()
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.*
      `, [workerId, allowedTypes]);
  return result.rows[0] || null;
}
async function renewPlatformJobLease(pool, { jobId, workerId }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (jobId === undefined || jobId === null || !workerId || typeof workerId !== 'string') {
    throw new TypeError('jobId and workerId are required to renew a lease');
  }
  const renewed = await pool.query(`
    UPDATE platform_jobs
    SET locked_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND locked_by = $2 AND status = 'processing'
    RETURNING id, locked_at
  `, [jobId, workerId]);
  return renewed.rowCount > 0;
}

async function completePlatformJob(pool, { jobId, workerId, result = {} }) {
  const saved = await pool.query(`
    UPDATE platform_jobs
    SET status = 'completed',
        payload = payload || jsonb_build_object('result', $3::jsonb),
        locked_by = NULL,
        locked_at = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE id = $1 AND locked_by = $2 AND status = 'processing'
    RETURNING id, status, updated_at
  `, [jobId, workerId, jsonValue(result, 'result')]);
  if (!saved.rowCount) throw new Error('Job lease lost before completion');
  return saved.rows[0];
}

async function failPlatformJob(pool, { jobId, workerId, error, retryDelaySeconds }) {
  const message = String(error && error.message ? error.message : error || 'Unknown job error')
    .slice(0, MAX_ERROR_LENGTH);
  const delay = Math.max(1, Math.min(300, Number(retryDelaySeconds) || 5));
  const saved = await pool.query(`
    UPDATE platform_jobs
    SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retrying' END,
        available_at = CASE
          WHEN attempts >= max_attempts THEN available_at
          ELSE NOW() + make_interval(secs => $4::int)
        END,
        locked_by = NULL,
        locked_at = NULL,
        last_error = $3,
        updated_at = NOW()
    WHERE id = $1 AND locked_by = $2 AND status = 'processing'
    RETURNING id, status, attempts, max_attempts, available_at
  `, [jobId, workerId, message, delay]);
  if (!saved.rowCount) throw new Error('Job lease lost before failure could be recorded');
  return saved.rows[0];
}

async function recoverExpiredPlatformJobs(pool, leaseSeconds = 120, jobTypes) {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) {
    throw new RangeError('leaseSeconds must be an integer of at least 10');
  }
  const allowedTypes = normalizeJobTypes(jobTypes);
  const result = await pool.query(`
        UPDATE platform_jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retrying' END,
            available_at = CASE
              WHEN attempts >= max_attempts THEN available_at
              ELSE NOW()
            END,
            locked_by = NULL,
            locked_at = NULL,
            last_error = LEFT(COALESCE(last_error, 'Worker lease expired'), 4000),
            updated_at = NOW()
        WHERE status = 'processing'
          AND locked_at < NOW() - make_interval(secs => $1::int)
          AND job_type = ANY($2::text[])
        RETURNING id, status
      `, [leaseSeconds, allowedTypes]);
  return result.rows;
}
async function enqueueTelegramUpdate(pool, { botId, update }) {
  if (!Number.isSafeInteger(Number(botId)) || Number(botId) < 1) {
    throw new TypeError('A valid botId is required');
  }
  if (!update || typeof update !== 'object' || Array.isArray(update) ||
      !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    throw new TypeError('Telegram update_id is required');
  }
  const result = await pool.query(`
    WITH inserted AS (
      INSERT INTO bot_inbound_updates (bot_id, update_id, payload)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (bot_id, update_id) DO NOTHING
      RETURNING id
    ),
    queued AS (
      INSERT INTO platform_jobs (job_type, bot_id, idempotency_key, payload)
      SELECT
        'telegram.update',
        $1,
        'telegram.update:' || $1::text || ':' || $2::text,
        jsonb_build_object('botId', $1, 'updateId', $2)
      FROM inserted
      ON CONFLICT (job_type, idempotency_key) DO NOTHING
      RETURNING id
    )
    SELECT inserted.id, queued.id AS job_id
    FROM inserted
    LEFT JOIN queued ON TRUE
  `, [botId, update.update_id, jsonValue(update, 'update')]);

  return {
    accepted: true,
    duplicate: result.rowCount === 0,
    id: result.rows[0]?.id || null,
    jobId: result.rows[0]?.job_id || null
  };
}


async function enqueuePlatformBotUpdate(pool, { botIdentity, update }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (!['master', 'intake'].includes(botIdentity)) {
    throw new TypeError('botIdentity must be master or intake');
  }
  if (!update || typeof update !== 'object' || Array.isArray(update) ||
      !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    throw new TypeError('Telegram update_id is required');
  }

  const jobType = 'telegram.' + botIdentity + '.update';
  const idempotencyKey = jobType + ':' + update.update_id;
  const result = await pool.query(`
    WITH inbox AS (
      INSERT INTO platform_bot_inbound_updates (bot_identity, update_id, payload)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (bot_identity, update_id)
      DO UPDATE SET payload = platform_bot_inbound_updates.payload
      RETURNING id, state, (xmax = 0) AS inserted
    ),
    queued AS (
      INSERT INTO platform_jobs (job_type, idempotency_key, payload)
      SELECT $4, $5,
        jsonb_build_object('botIdentity', $1, 'updateId', $2)
      FROM inbox
      WHERE inbox.state IN ('queued', 'failed', 'processing')
      ON CONFLICT (job_type, idempotency_key)
      DO UPDATE SET idempotency_key = platform_jobs.idempotency_key
      RETURNING id, (xmax = 0) AS inserted
    )
    SELECT
      inbox.id,
      inbox.state,
      inbox.inserted,
      queued.id AS job_id,
      queued.inserted AS job_inserted
    FROM inbox
    LEFT JOIN queued ON TRUE
  `, [
    botIdentity,
    update.update_id,
    jsonValue(update, 'update'),
    jobType,
    idempotencyKey
  ]);
  const row = result.rows[0];

  if (!row) {
    throw new Error('Platform inbox enqueue returned no row');
  }

  // Terminal inbox states must never be re-enqueued.
  if (row.state === 'processed' || row.state === 'dead_letter') {
    return { accepted: true, duplicate: true, id: null, jobId: null };
  }

  if (!row.job_id) {
    throw new Error('Platform inbox row has no durable queue job');
  }

  // A missing job is repaired even when the inbox row already existed.
  const duplicate = !row.inserted && !row.job_inserted;

  if (duplicate) {
    return { accepted: true, duplicate: true, id: null, jobId: null };
  }

  return {
    accepted: true,
    duplicate: false,
    id: row.id,
    jobId: row.job_id
  };
}

module.exports = {
  enqueuePlatformJob,
  normalizeJobTypes,
  claimPlatformJob,
  renewPlatformJobLease,
  completePlatformJob,
  failPlatformJob,
  recoverExpiredPlatformJobs,
  enqueueTelegramUpdate,
  enqueuePlatformBotUpdate
};
