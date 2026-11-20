'use strict';

const { pool } = require('./db');

async function initProjectAiJobsDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_ai_jobs (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
      spec_version INTEGER NOT NULL,
      job_type TEXT NOT NULL DEFAULT 'analysis',
      status TEXT NOT NULL DEFAULT 'queued',
      requested_by_admin TEXT NOT NULL,
      analysis JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, spec_version, job_type)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_ai_job_attempts (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT NOT NULL REFERENCES project_ai_jobs(id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE (job_id, attempt_no)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS project_ai_job_attempts_job_idx
    ON project_ai_job_attempts(job_id, attempt_no DESC)
  `);
}

async function createProjectAiJob({
  projectId,
  adminTelegramId,
  jobType = 'analysis'
}) {
  const result = await pool.query(`
    INSERT INTO project_ai_jobs
      (project_id, spec_version, job_type, status, requested_by_admin)
    SELECT
      p.id, s.version, $3, 'queued', $2
    FROM client_projects p
    JOIN LATERAL (
      SELECT version
      FROM project_specs
      WHERE project_id = p.id AND status = 'approved'
      ORDER BY version DESC
      LIMIT 1
    ) s ON TRUE
    WHERE p.id = $1 AND p.status = 'spec_approved'
    ON CONFLICT (project_id, spec_version, job_type)
    DO UPDATE SET
      status = 'queued',
      error = NULL,
      started_at = NULL,
      completed_at = NULL,
      requested_by_admin = EXCLUDED.requested_by_admin,
      updated_at = NOW()
    WHERE project_ai_jobs.status = 'failed'
    RETURNING *
  `, [projectId, String(adminTelegramId), jobType]);

  if (result.rows[0]) return result.rows[0];

  const existing = await pool.query(`
    SELECT j.*
    FROM project_ai_jobs j
    JOIN client_projects p
      ON p.id = j.project_id
     AND p.status = 'spec_approved'
    JOIN LATERAL (
      SELECT version
      FROM project_specs
      WHERE project_id = p.id
        AND status = 'approved'
      ORDER BY version DESC
      LIMIT 1
    ) s ON s.version = j.spec_version
    WHERE j.project_id = $1
      AND j.job_type = $2
    ORDER BY j.id DESC
    LIMIT 1
  `, [projectId, jobType]);

  if (existing.rows[0]) return existing.rows[0];

  throw new Error('المشروع غير معتمد أو لا توجد مواصفات معتمدة');
}

async function getLatestCompletedProjectAiJob({
  projectId,
  jobType = 'analysis'
}) {
  const result = await pool.query(`
    SELECT j.*
    FROM project_ai_jobs j
    JOIN client_projects p
      ON p.id = j.project_id
     AND p.status = 'spec_approved'
    JOIN LATERAL (
      SELECT version
      FROM project_specs
      WHERE project_id = p.id
        AND status = 'approved'
      ORDER BY version DESC
      LIMIT 1
    ) s ON s.version = j.spec_version
    WHERE j.project_id = $1
      AND j.job_type = $2
      AND j.status = 'completed'
    ORDER BY j.id DESC
    LIMIT 1
  `, [projectId, jobType]);

  return result.rows[0] || null;
}

async function getProjectAiJobAttempts(jobId) {
  const result = await pool.query(`
    SELECT *
    FROM project_ai_job_attempts
    WHERE job_id = $1
    ORDER BY attempt_no ASC
  `, [jobId]);

  return result.rows;
}

async function startProjectAiJobAttempt(jobId, { allowCompleted = false } = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const selected = await client.query(`
      SELECT *
      FROM project_ai_jobs
      WHERE id = $1
      FOR UPDATE
    `, [jobId]);

    const job = selected.rows[0];

    if (!job) {
      throw new Error('مهمة الذكاء الاصطناعي غير موجودة.');
    }

    if (job.status === 'running') {
      throw new Error('المرحلة قيد التنفيذ بالفعل.');
    }

    if (job.status === 'completed' && !allowCompleted) {
      await client.query('COMMIT');
      return null;
    }

    const count = await client.query(`
      SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_attempt
      FROM project_ai_job_attempts
      WHERE job_id = $1
    `, [jobId]);

    const attemptNo = Number(count.rows[0].next_attempt);

    const inserted = await client.query(`
      INSERT INTO project_ai_job_attempts
        (job_id, attempt_no, status)
      VALUES ($1, $2, 'running')
      RETURNING *
    `, [jobId, attemptNo]);

    await client.query(`
      UPDATE project_ai_jobs
      SET status = 'running',
          started_at = NOW(),
          completed_at = NULL,
          error = NULL,
          updated_at = NOW()
      WHERE id = $1
    `, [jobId]);

    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function completeProjectAiJobAttempt(attemptId, jobId, result) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const savedAttempt = await client.query(`
      UPDATE project_ai_job_attempts
      SET status = 'completed',
          result = $2::jsonb,
          error = NULL,
          completed_at = NOW()
      WHERE id = $1 AND job_id = $3 AND status = 'running'
      RETURNING id
    `, [attemptId, JSON.stringify(result), jobId]);

    if (!savedAttempt.rows[0]) {
      throw new Error('تعذر حفظ نتيجة محاولة التنفيذ.');
    }

    const savedJob = await client.query(`
      UPDATE project_ai_jobs
      SET status = 'completed',
          analysis = $2::jsonb,
          error = NULL,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND status = 'running'
      RETURNING *
    `, [jobId, JSON.stringify(result)]);

    if (!savedJob.rows[0]) {
      throw new Error('تعذر تحديث حالة المرحلة.');
    }

    await client.query('COMMIT');
    return savedJob.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function failProjectAiJobAttempt(attemptId, jobId, error) {
  const message = String(error || 'خطأ غير معروف').slice(0, 3000);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const failedAttempt = await client.query(`
      UPDATE project_ai_job_attempts
      SET status = 'failed',
          error = $2,
          completed_at = NOW()
      WHERE id = $1 AND job_id = $3 AND status = 'running'
      RETURNING id
    `, [attemptId, message, jobId]);

    if (!failedAttempt.rows[0]) {
      throw new Error('تعذر تحديث سجل محاولة الفشل.');
    }

    const failed = await client.query(`
      UPDATE project_ai_jobs
      SET status = 'failed',
          error = $2,
          updated_at = NOW()
      WHERE id = $1 AND status = 'running'
      RETURNING id
    `, [jobId, message]);

    if (!failed.rows[0]) {
      throw new Error('تعذر تحديث حالة المهمة إلى failed.');
    }

    await client.query('COMMIT');
    return failed.rows[0] || null;
  } catch (failure) {
    await client.query('ROLLBACK');
    throw failure;
  } finally {
    client.release();
  }
}

/* الوظائف القديمة محفوظة للتوافق مع الأجزاء الأخرى من النظام. */
async function markProjectAiJobRunning(jobId) {
  const result = await pool.query(`
    UPDATE project_ai_jobs
    SET status = 'running',
        started_at = NOW(),
        completed_at = NULL,
        updated_at = NOW(),
        error = NULL
    WHERE id = $1 AND status = 'queued'
    RETURNING *
  `, [jobId]);

  return result.rows[0] || null;
}

async function completeProjectAiJob(jobId, analysis) {
  const result = await pool.query(`
    UPDATE project_ai_jobs
    SET status = 'completed',
        analysis = $2::jsonb,
        error = NULL,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = $1 AND status = 'running'
    RETURNING *
  `, [jobId, JSON.stringify(analysis)]);

  return result.rows[0] || null;
}

async function failProjectAiJob(jobId, error) {
  const result = await pool.query(`
    UPDATE project_ai_jobs
    SET status = 'failed',
        error = $2,
        updated_at = NOW()
    WHERE id = $1 AND status = 'running'
    RETURNING *
  `, [jobId, String(error).slice(0, 3000)]);

  return result.rows[0] || null;
}

async function recoverInterruptedProjectAiJobs() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const interrupted = await client.query(`
      UPDATE project_ai_job_attempts a
      SET status = 'failed',
          error = 'توقفت المحاولة بسبب إعادة تشغيل الخدمة.',
          completed_at = NOW()
      FROM project_ai_jobs j
      WHERE a.job_id = j.id
        AND j.status = 'running'
        AND a.status = 'running'
      RETURNING a.id
    `);

    const jobs = await client.query(`
      UPDATE project_ai_jobs
      SET status = 'failed',
          error = 'توقف التنفيذ بسبب إعادة تشغيل الخدمة. يمكنك إعادة المحاولة.',
          updated_at = NOW()
      WHERE status = 'running'
      RETURNING id
    `);

    await client.query('COMMIT');
    return jobs.rowCount || 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function acquireProjectPipelineLock(projectId) {
  const client = await pool.connect();

  try {
    const result = await client.query(`
      SELECT pg_try_advisory_lock(
        hashtext('boss-project-pipeline'),
        hashtext($1)
      ) AS locked
    `, [String(projectId)]);

    if (!result.rows[0].locked) {
      client.release();
      return null;
    }

    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseProjectPipelineLock(client, projectId) {
  if (!client) return;

  try {
    await client.query(`
      SELECT pg_advisory_unlock(
        hashtext('boss-project-pipeline'),
        hashtext($1)
      )
    `, [String(projectId)]);
  } finally {
    client.release();
  }
}

module.exports = {
  initProjectAiJobsDatabase,
  createProjectAiJob,
  getLatestCompletedProjectAiJob,
  getProjectAiJobAttempts,
  startProjectAiJobAttempt,
  completeProjectAiJobAttempt,
  failProjectAiJobAttempt,
  acquireProjectPipelineLock,
  releaseProjectPipelineLock,
  markProjectAiJobRunning,
  completeProjectAiJob,
  failProjectAiJob,
  recoverInterruptedProjectAiJobs
};
