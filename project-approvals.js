'use strict';

const { pool } = require('./db');

const { buildConstructionPoints } = require('./project-construction-points');


async function initProjectApprovalsDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_build_approvals (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
      spec_version INTEGER NOT NULL,
      design_job_id BIGINT NOT NULL REFERENCES project_ai_jobs(id) ON DELETE CASCADE,
      construction_points JSONB NOT NULL DEFAULT '{}'::jsonb,
      construction_points_approved BOOLEAN NOT NULL DEFAULT FALSE,
      design_approved BOOLEAN NOT NULL DEFAULT FALSE,
      points_approved_by TEXT,
      design_approved_by TEXT,
      points_approved_at TIMESTAMPTZ,
      design_approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, spec_version, design_job_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS project_build_approvals_project_idx
    ON project_build_approvals(project_id, spec_version)
  `);
}

async function getProjectApprovalState({ projectId, specVersion, designJobId }) {
  const result = await pool.query(`
    SELECT *
    FROM project_build_approvals
    WHERE project_id = $1
      AND spec_version = $2
      AND design_job_id = $3
    LIMIT 1
  `, [projectId, specVersion, designJobId]);

  return result.rows[0] || null;
}

async function approveProjectMilestone({
  projectId,
  designJobId,
  approvalType,
  adminTelegramId
}) {
  if (!['construction_points', 'design'].includes(approvalType)) {
    throw new Error('نوع الاعتماد غير صالح.');
  }

  if (!/^\d+$/.test(String(projectId)) ||
      !/^\d+$/.test(String(designJobId)) ||
      !/^\d+$/.test(String(adminTelegramId))) {
    throw new Error('بيانات الاعتماد غير صحيحة.');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const current = await client.query(`
      SELECT s.version, s.spec
      FROM client_projects p
      JOIN LATERAL (
        SELECT version, spec
        FROM project_specs
        WHERE project_id = p.id AND status = 'approved'
        ORDER BY version DESC
        LIMIT 1
      ) s ON TRUE
      JOIN project_ai_jobs j
        ON j.project_id = p.id
       AND j.spec_version = s.version
       AND j.job_type = 'design'
       AND j.status = 'completed'
       AND j.id = $2
      WHERE p.id = $1
        AND p.status = 'spec_approved'
      FOR UPDATE OF p
    `, [projectId, designJobId]);

    if (!current.rowCount) {
      throw new Error('التصميم غير مكتمل أو لم يعد مرتبطاً بآخر مواصفات معتمدة. أعد فتح AI DESIGNER.');
    }

    const constructionPoints = buildConstructionPoints(current.rows[0].spec);

    const result = await client.query(`
      INSERT INTO project_build_approvals (
        project_id, spec_version, design_job_id, construction_points,
        construction_points_approved, design_approved,
        points_approved_by, design_approved_by,
        points_approved_at, design_approved_at
      )
      SELECT
        p.id, s.version, j.id, $3::jsonb,
        $4 = 'construction_points',
        $4 = 'design',
        CASE WHEN $4 = 'construction_points' THEN $5 ELSE NULL END,
        CASE WHEN $4 = 'design' THEN $5 ELSE NULL END,
        CASE WHEN $4 = 'construction_points' THEN NOW() ELSE NULL END,
        CASE WHEN $4 = 'design' THEN NOW() ELSE NULL END
      FROM client_projects p
      JOIN LATERAL (
        SELECT version
        FROM project_specs
        WHERE project_id = p.id AND status = 'approved'
        ORDER BY version DESC
        LIMIT 1
      ) s ON TRUE
      JOIN project_ai_jobs j
        ON j.project_id = p.id
       AND j.spec_version = s.version
       AND j.job_type = 'design'
       AND j.status = 'completed'
       AND j.id = $2
      WHERE p.id = $1
        AND p.status = 'spec_approved'
      ON CONFLICT (project_id, spec_version, design_job_id)
      DO UPDATE SET
        construction_points = EXCLUDED.construction_points,
        construction_points_approved =
          project_build_approvals.construction_points_approved
          OR EXCLUDED.construction_points_approved,
        design_approved =
          project_build_approvals.design_approved
          OR EXCLUDED.design_approved,
        points_approved_by = CASE
          WHEN EXCLUDED.construction_points_approved
          THEN EXCLUDED.points_approved_by
          ELSE project_build_approvals.points_approved_by
        END,
        design_approved_by = CASE
          WHEN EXCLUDED.design_approved
          THEN EXCLUDED.design_approved_by
          ELSE project_build_approvals.design_approved_by
        END,
        points_approved_at = COALESCE(
          project_build_approvals.points_approved_at,
          EXCLUDED.points_approved_at
        ),
        design_approved_at = COALESCE(
          project_build_approvals.design_approved_at,
          EXCLUDED.design_approved_at
        ),
        updated_at = NOW()
      RETURNING *
    `, [
      projectId,
      designJobId,
      JSON.stringify(constructionPoints),
      approvalType,
      String(adminTelegramId)
    ]);

    if (!result.rowCount) {
      throw new Error('التصميم غير مكتمل أو لم يعد مرتبطاً بآخر مواصفات معتمدة. أعد فتح AI DESIGNER.');
    }

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  initProjectApprovalsDatabase,
  getProjectApprovalState,
  approveProjectMilestone,
  buildConstructionPoints
};
