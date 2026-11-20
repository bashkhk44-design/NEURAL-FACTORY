'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
let pool;
const { buildReleaseReport, createReleaseCandidate, decideRelease, authorizeDeployment, initProjectReleaseDatabase } = require('../project-release');

test('PostgreSQL release handoff enforces customer then manager approval and immutable artifact', { skip: !process.env.DATABASE_URL }, async () => {
  let clientId;
  let projectId;
  const customerTelegramId = String(900000000 + Math.floor(Math.random() * 90000000));
  const managerTelegramId = '10001';

  try {
    pool = require('../db').pool;
    pool.options.ssl = false;
    await pool.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_name TEXT');
    await pool.query('ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS name TEXT');
    await pool.query("ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS business_type TEXT");
    await pool.query("ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'spec_approved'");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_specs (
        id BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        spec JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'draft',
        approved_at TIMESTAMPTZ,
        UNIQUE (project_id, version)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_ai_jobs (
        id BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
        spec_version INTEGER NOT NULL,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by_admin TEXT NOT NULL,
        analysis JSONB
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_build_approvals (
        id BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
        spec_version INTEGER NOT NULL,
        design_job_id BIGINT NOT NULL REFERENCES project_ai_jobs(id),
        construction_points JSONB NOT NULL DEFAULT '{}'::jsonb,
        construction_points_approved BOOLEAN NOT NULL DEFAULT FALSE,
        design_approved BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await initProjectReleaseDatabase();

    const client = await pool.query(
      'INSERT INTO clients (telegram_user_id, first_name) VALUES ($1, $2) RETURNING id',
      [customerTelegramId, 'Release integration fixture']
    );
    clientId = client.rows[0].id;

    const project = await pool.query(
      'INSERT INTO client_projects (client_id, name, business_type, status) VALUES ($1, $2, $3, $4) RETURNING id',
      [clientId, 'Release integration project', 'other', 'spec_approved']
    );
    projectId = project.rows[0].id;

    await pool.query(
      'INSERT INTO project_specs (project_id, version, spec, status, approved_at) VALUES ($1, 1, $2::jsonb, $3, NOW())',
      [projectId, JSON.stringify({ description: 'approved fixture' }), 'approved']
    );

    const designJob = await pool.query(
      'INSERT INTO project_ai_jobs (project_id, spec_version, job_type, status, requested_by_admin, analysis) VALUES ($1, 1, $2, $3, $4, $5::jsonb) RETURNING id',
      [projectId, 'design', 'completed', managerTelegramId, '{}']
    );
    const designJobId = designJob.rows[0].id;

    await pool.query(
      'INSERT INTO project_build_approvals (project_id, spec_version, design_job_id, construction_points, construction_points_approved, design_approved) VALUES ($1, 1, $2, $3::jsonb, TRUE, TRUE)',
      [projectId, designJobId, '{}']
    );

    const releaseProject = {
      project_id: projectId,
      project_name: 'Release integration project',
      business_type: 'other',
      spec_version: 1
    };
    const design = {
      text: 'Approved design fixture',
      artifact: { specVersion: 1, sourceFingerprint: 'b'.repeat(64) }
    };
    const testResult = {
      passed: true,
      sandbox: {
        executionStatus: 'completed',
        testSummary: { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
        acceptanceTests: [{ acceptanceTestId: 'main', passed: true }]
      }
    };
    const report = buildReleaseReport({
      project: releaseProject,
      spec: { description: 'approved fixture' },
      design,
      testResult,
      deployment: { ready: false, checks: [{ name: 'hosting', passed: false, details: 'Not connected' }] }
    });
    const candidate = await createReleaseCandidate({
      project: releaseProject,
      designJobId,
      adminTelegramId: managerTelegramId,
      report,
      bundle: { files: [{ path: 'index.js', content: "console.log('release');" }] }
    });

    assert.equal(candidate.status, 'awaiting_customer');
    const duplicateCandidate = await createReleaseCandidate({
      project: releaseProject,
      designJobId,
      adminTelegramId: managerTelegramId,
      report,
      bundle: { files: [{ path: 'index.js', content: "console.log('release');" }] }
    });
    assert.equal(duplicateCandidate.id, candidate.id);
    await assert.rejects(
      decideRelease({ releaseId: candidate.id, role: 'manager', telegramUserId: managerTelegramId, decision: 'approved' }),
      /قبل موافقة العميل/
    );
    await assert.rejects(
      decideRelease({ releaseId: candidate.id, role: 'customer', telegramUserId: '999999999', decision: 'approved' }),
      /لا يخص حساب Telegram/
    );

    await assert.rejects(
      authorizeDeployment({ releaseId: candidate.id, telegramUserId: managerTelegramId }),
      /قبل موافقة العميل والمدير/
    );

    const customerDecision = await decideRelease({
      releaseId: candidate.id, role: 'customer',
      telegramUserId: customerTelegramId, decision: 'approved'
    });
    assert.equal(customerDecision.status, 'awaiting_manager');

    const managerDecision = await decideRelease({
      releaseId: candidate.id, role: 'manager',
      telegramUserId: managerTelegramId, decision: 'approved'
    });
    assert.equal(managerDecision.status, 'approved');

    const authorization = await authorizeDeployment({
      releaseId: candidate.id,
      telegramUserId: managerTelegramId
    });
    assert.equal(authorization.status, 'authorized');
    assert.equal(authorization.release_id, candidate.id);
    assert.match(authorization.authorization_sha256, /^[a-f0-9]{64}$/);
    const duplicateAuthorization = await authorizeDeployment({
      releaseId: candidate.id,
      telegramUserId: managerTelegramId
    });
    assert.equal(duplicateAuthorization.id, authorization.id);
    await assert.rejects(
      pool.query(
        'UPDATE project_deployment_authorizations SET authorized_by = $2 WHERE id = $1',
        [authorization.id, '99999']
      ),
      /immutable/
    );

    await assert.rejects(
      pool.query(
        'DELETE FROM project_deployment_authorizations WHERE id = $1',
        [authorization.id]
      ),
      /immutable/
    );

    await assert.rejects(
      pool.query('UPDATE project_release_candidates SET artifact_sha256 = $2 WHERE id = $1', [candidate.id, 'c'.repeat(64)]),
      /immutable/
    );

    const approvals = await pool.query(
      'SELECT approver_role, decision FROM project_release_approvals WHERE release_id = $1 ORDER BY approver_role',
      [candidate.id]
    );
    assert.equal(approvals.rowCount, 2);
    assert.deepEqual(approvals.rows.map(row => row.decision), ['approved', 'approved']);
  } finally {
    if (projectId) await pool.query('DELETE FROM client_projects WHERE id = $1', [projectId]);
    if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    await pool.end();
  }
});
