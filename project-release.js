'use strict';

const crypto = require('node:crypto');
function getPool() { return require('./db').pool; }

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildReleaseReport({ project, spec, design, testResult, deployment }) {
  if (!project?.project_id || !Number.isInteger(Number(project.spec_version))) {
    throw new Error('بيانات المشروع أو إصدار المواصفات غير صالحة.');
  }
  if (!design?.artifact?.sourceFingerprint ||
      Number(design.artifact.specVersion) !== Number(project.spec_version)) {
    throw new Error('التصميم لا يطابق إصدار المواصفات المعتمد.');
  }
  if (testResult?.passed !== true ||
      testResult?.sandbox?.executionStatus !== 'completed') {
    throw new Error('لا يمكن تجهيز تقرير تسليم دون نجاح اختبار مكتمل داخل البيئة المعزولة.');
  }
  const verifiedSummary = testResult.sandbox.testSummary || {};
  if (Number(verifiedSummary.tests) < 1 ||
      Number(verifiedSummary.passed) !== Number(verifiedSummary.tests) ||
      Number(verifiedSummary.failed || 0) !== 0 ||
      Number(verifiedSummary.skipped || 0) !== 0 ||
      Number(verifiedSummary.todo || 0) !== 0 ||
      Number(verifiedSummary.cancelled || 0) !== 0 ||
      !Array.isArray(testResult.sandbox.acceptanceTests) ||
      !testResult.sandbox.acceptanceTests.length ||
      !testResult.sandbox.acceptanceTests.every(item => item.passed === true)) {
    throw new Error('ملخص الاختبارات أو تغطية اختبارات القبول غير مكتملة.');
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('نسخة مواصفات العميل غير صالحة للتقرير.');
  }

  const checks = Array.isArray(deployment?.checks)
    ? deployment.checks.map(item => ({
        name: String(item.name || 'unknown').slice(0, 100),
        passed: item.passed === true,
        details: String(item.details || '').slice(0, 1000)
      }))
    : [];

  const failedChecks = checks.filter(item => !item.passed);
  const testSummary = testResult.sandbox.testSummary || {};
  const acceptanceTests = Array.isArray(testResult.sandbox.acceptanceTests)
    ? testResult.sandbox.acceptanceTests.map(item => ({
        acceptanceTestId: String(item.acceptanceTestId || '').slice(0, 100),
        passed: item.passed === true
      }))
    : [];

  return {
    schemaVersion: 1,
    project: {
      id: String(project.project_id),
      name: String(project.project_name || project.name || '').slice(0, 200),
      businessType: String(project.business_type || '').slice(0, 100)
    },
    approvals: {
      customerSpec: {
        status: 'approved',
        specVersion: Number(project.spec_version),
        details: spec && typeof spec === 'object' ? spec : {}
      },
      managerConstructionPoints: 'approved',
      managerDesign: 'approved'
    },
    design: {
      specVersion: Number(design.artifact.specVersion),
      sourceFingerprint: design.artifact.sourceFingerprint,
      summary: String(design.text || '').slice(0, 12000)
    },
    tests: {
      status: 'passed',
      executionStatus: testResult.sandbox.executionStatus,
      summary: {
        tests: Number(testSummary.tests || 0),
        passed: Number(testSummary.passed || 0),
        failed: Number(testSummary.failed || 0),
        skipped: Number(testSummary.skipped || 0),
        todo: Number(testSummary.todo || 0),
        cancelled: Number(testSummary.cancelled || 0)
      },
      acceptanceTests
    },
    releaseChecks: checks,
    risks: failedChecks.map(item => ({
      type: 'deployment_precheck',
      check: item.name,
      details: item.details
    })),
    deployment: {
      deployed: false,
      ready: deployment?.ready === true
    },
    generatedAt: new Date().toISOString()
  };
}

function createImmutableReleaseArtifact({ report, bundle }) {
  if (!report || !bundle || !Array.isArray(bundle.files) || !bundle.files.length) {
    throw new Error('تقرير الإصدار أو ملفات المشروع غير مكتملة.');
  }
  const seenPaths = new Set();
  const files = bundle.files.map(file => {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('ملف ضمن حزمة الإصدار غير صالح.');
    }
    const normalizedPath = file.path.replaceAll(String.fromCharCode(92), '/');
    if (file.path.startsWith('/') ||
        /^[A-Za-z]:/.test(file.path) ||
        file.path.startsWith(String.fromCharCode(92)) ||
        normalizedPath.split('/').includes('..') ||
        file.path.includes(String.fromCharCode(0))) {
      throw new Error('مسار ملف غير آمن ضمن حزمة الإصدار.');
    }
    if (seenPaths.has(file.path)) throw new Error('يوجد مسار مكرر ضمن حزمة الإصدار.');
    seenPaths.add(file.path);
    return { path: file.path, content: file.content };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const payload = {
    schemaVersion: 1,
    report,
    bundle: { files }
  };
  const serialized = stableJson(payload);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new Error('حزمة الإصدار تتجاوز الحد الآمن البالغ 4 ميغابايت.');
  }
  return {
    artifact: payload,
    artifactSha256: sha256(serialized),
    artifactBytes: bytes
  };
}

async function initProjectReleaseDatabase() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_release_candidates (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
      release_version INTEGER NOT NULL,
      spec_version INTEGER NOT NULL,
      design_job_id BIGINT NOT NULL REFERENCES project_ai_jobs(id),
      created_by TEXT NOT NULL,
      artifact JSONB NOT NULL,
      artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
      artifact_bytes INTEGER NOT NULL CHECK (artifact_bytes > 0),
      status TEXT NOT NULL CHECK (status IN ('awaiting_customer', 'awaiting_manager', 'approved', 'rejected')),
      customer_telegram_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, release_version)
    )
  `);

  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_release_approvals (
      id BIGSERIAL PRIMARY KEY,
      release_id BIGINT NOT NULL REFERENCES project_release_candidates(id) ON DELETE CASCADE,
      approver_role TEXT NOT NULL CHECK (approver_role IN ('customer', 'manager')),
      telegram_user_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (release_id, approver_role)
    )
  `);

  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_deployment_authorizations (
      id BIGSERIAL PRIMARY KEY,
      release_id BIGINT NOT NULL UNIQUE REFERENCES project_release_candidates(id) ON DELETE CASCADE,
      authorized_by TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('authorized')),
      authorization_sha256 TEXT NOT NULL CHECK (authorization_sha256 ~ '^[a-f0-9]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await getPool().query(`
    CREATE OR REPLACE FUNCTION prevent_project_deployment_authorization_mutation()
    RETURNS trigger AS $deployment_auth$
    BEGIN
      IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'deployment authorizations are immutable';
    END;
    $deployment_auth$ LANGUAGE plpgsql
  `);

  await getPool().query(`
    DROP TRIGGER IF EXISTS project_deployment_authorization_immutable
    ON project_deployment_authorizations
  `);
  await getPool().query(`
    CREATE TRIGGER project_deployment_authorization_immutable
    BEFORE UPDATE OR DELETE ON project_deployment_authorizations
    FOR EACH ROW EXECUTE FUNCTION prevent_project_deployment_authorization_mutation()
  `);

  await getPool().query(`
    CREATE INDEX IF NOT EXISTS project_release_project_idx
    ON project_release_candidates(project_id, release_version DESC)
  `);

  await getPool().query(`
    CREATE UNIQUE INDEX IF NOT EXISTS project_release_one_open_per_project_idx
    ON project_release_candidates(project_id)
    WHERE status IN ('awaiting_customer', 'awaiting_manager')
  `);

  await getPool().query(`
    CREATE OR REPLACE FUNCTION prevent_project_release_artifact_mutation()
    RETURNS trigger AS $release$
    BEGIN
      IF NEW.project_id IS DISTINCT FROM OLD.project_id OR
         NEW.release_version IS DISTINCT FROM OLD.release_version OR
         NEW.spec_version IS DISTINCT FROM OLD.spec_version OR
         NEW.design_job_id IS DISTINCT FROM OLD.design_job_id OR
         NEW.artifact IS DISTINCT FROM OLD.artifact OR
         NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256 OR
         NEW.artifact_bytes IS DISTINCT FROM OLD.artifact_bytes OR
         NEW.created_by IS DISTINCT FROM OLD.created_by OR
         NEW.customer_telegram_id IS DISTINCT FROM OLD.customer_telegram_id OR
         NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Release artifact fields are immutable';
      END IF;
      RETURN NEW;
    END;
    $release$ LANGUAGE plpgsql
  `);

  await getPool().query(`
    DROP TRIGGER IF EXISTS project_release_artifact_immutable
    ON project_release_candidates
  `);
  await getPool().query(`
    CREATE TRIGGER project_release_artifact_immutable
    BEFORE UPDATE ON project_release_candidates
    FOR EACH ROW EXECUTE FUNCTION prevent_project_release_artifact_mutation()
  `);
}

async function createReleaseCandidate({ project, designJobId, adminTelegramId, report, bundle }) {
  const snapshot = createImmutableReleaseArtifact({ report, bundle });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`
      SELECT p.id, c.telegram_user_id, s.version, j.id AS design_job_id,
             a.construction_points_approved, a.design_approved
      FROM client_projects p
      JOIN clients c ON c.id = p.client_id
      JOIN LATERAL (
        SELECT version FROM project_specs
        WHERE project_id = p.id AND status = 'approved'
        ORDER BY version DESC LIMIT 1
      ) s ON TRUE
      JOIN project_ai_jobs j
        ON j.project_id = p.id AND j.id = $2
       AND j.job_type = 'design' AND j.status = 'completed'
       AND j.spec_version = s.version
      JOIN project_build_approvals a
        ON a.project_id = p.id AND a.spec_version = s.version
       AND a.design_job_id = j.id
      WHERE p.id = $1 AND p.status = 'spec_approved'
      FOR UPDATE OF p
    `, [project.project_id, designJobId]);

    if (!current.rowCount ||
        !current.rows[0].construction_points_approved ||
        !current.rows[0].design_approved ||
        Number(current.rows[0].version) !== Number(project.spec_version)) {
      throw new Error('تعذر إنشاء الإصدار: المواصفات أو التصميم أو اعتمادات المدير لم تعد مطابقة.');
    }

    const pending = await client.query(`
      SELECT id, project_id, release_version, spec_version,
             artifact_sha256, artifact_bytes, status, created_at
      FROM project_release_candidates
      WHERE project_id = $1
        AND status IN ('awaiting_customer', 'awaiting_manager')
      ORDER BY release_version DESC
      LIMIT 1
      FOR UPDATE
    `, [project.project_id]);

    if (pending.rowCount) {
      if (pending.rows[0].artifact_sha256 !== snapshot.artifactSha256) {
        throw new Error('يوجد إصدار سابق بانتظار موافقة العميل أو المدير. يجب إغلاقه قبل إنشاء إصدار جديد.');
      }
      await client.query('COMMIT');
      return {
        ...pending.rows[0],
        customerTelegramId: String(current.rows[0].telegram_user_id)
      };
    }

    const versionResult = await client.query(`
      SELECT COALESCE(MAX(release_version), 0) + 1 AS next_version
      FROM project_release_candidates WHERE project_id = $1
    `, [project.project_id]);

    const inserted = await client.query(`
      INSERT INTO project_release_candidates (
        project_id, release_version, spec_version, design_job_id,
        created_by, artifact, artifact_sha256, artifact_bytes,
        status, customer_telegram_id
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'awaiting_customer',$9)
      RETURNING id, project_id, release_version, spec_version,
                artifact_sha256, artifact_bytes, status, created_at
    `, [
      project.project_id,
      Number(versionResult.rows[0].next_version),
      project.spec_version,
      designJobId,
      String(adminTelegramId),
      JSON.stringify(snapshot.artifact),
      snapshot.artifactSha256,
      snapshot.artifactBytes,
      String(current.rows[0].telegram_user_id)
    ]);

    await client.query('COMMIT');
    return { ...inserted.rows[0], customerTelegramId: String(current.rows[0].telegram_user_id) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function getReleaseCandidate(releaseId) {
  if (!/^\d+$/.test(String(releaseId || ''))) throw new Error('رقم الإصدار غير صالح.');
  const result = await getPool().query(`
    SELECT r.*, p.name AS project_name,
           c.telegram_user_id AS customer_telegram_id
    FROM project_release_candidates r
    JOIN client_projects p ON p.id = r.project_id
    JOIN clients c ON c.id = p.client_id
    WHERE r.id = $1
  `, [releaseId]);
  return result.rows[0] || null;
}

async function decideRelease({ releaseId, role, telegramUserId, decision }) {
  if (!['customer', 'manager'].includes(role) ||
      !['approved', 'rejected'].includes(decision) ||
      !/^\d+$/.test(String(telegramUserId || '')) ||
      !/^\d+$/.test(String(releaseId || ''))) {
    throw new Error('بيانات قرار الإصدار غير صالحة.');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`
      SELECT r.*, c.telegram_user_id AS actual_customer_id
      FROM project_release_candidates r
      JOIN client_projects p ON p.id = r.project_id
      JOIN clients c ON c.id = p.client_id
      WHERE r.id = $1
      FOR UPDATE OF r
    `, [releaseId]);
    if (!found.rowCount) throw new Error('الإصدار غير موجود.');
    const release = found.rows[0];

    if (role === 'customer' && String(release.actual_customer_id) !== String(telegramUserId)) {
      throw new Error('هذا الإصدار لا يخص حساب Telegram الحالي.');
    }
    if (role === 'customer' && release.status !== 'awaiting_customer') {
      throw new Error('لم يعد الإصدار بانتظار قرار العميل.');
    }
    if (role === 'manager' && release.status !== 'awaiting_manager') {
      throw new Error('لا يمكن اعتماد المدير قبل موافقة العميل.');
    }
    if (release.status === 'approved' || release.status === 'rejected') {
      throw new Error('تم إغلاق قرار هذا الإصدار مسبقاً.');
    }

    await client.query(`
      INSERT INTO project_release_approvals
        (release_id, approver_role, telegram_user_id, decision)
      VALUES ($1,$2,$3,$4)
    `, [releaseId, role, String(telegramUserId), decision]);

    const nextStatus = decision === 'rejected'
      ? 'rejected'
      : role === 'customer' ? 'awaiting_manager' : 'approved';

    const updated = await client.query(`
      UPDATE project_release_candidates
      SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, project_id, release_version, spec_version,
                artifact_sha256, status
    `, [releaseId, nextStatus]);

    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}


async function authorizeDeployment({ releaseId, telegramUserId }) {
  if (!/^\d+$/.test(String(releaseId || '')) ||
      !/^\d+$/.test(String(telegramUserId || ''))) {
    throw new Error('بيانات تصريح النشر غير صالحة.');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`
      SELECT id, project_id, release_version, spec_version,
             artifact_sha256, status
      FROM project_release_candidates
      WHERE id = $1
      FOR UPDATE
    `, [releaseId]);
    if (!found.rowCount) throw new Error('الإصدار غير موجود.');
    const release = found.rows[0];
    if (release.status !== 'approved') {
      throw new Error('لا يمكن إصدار تصريح نشر قبل موافقة العميل والمدير على الإصدار.');
    }

    const authorizationHash = sha256(stableJson({
      releaseId: String(release.id),
      projectId: String(release.project_id),
      releaseVersion: Number(release.release_version),
      specVersion: Number(release.spec_version),
      artifactSha256: release.artifact_sha256,
      authorizedBy: String(telegramUserId)
    }));

    const inserted = await client.query(`
      INSERT INTO project_deployment_authorizations
        (release_id, authorized_by, status, authorization_sha256)
      VALUES ($1, $2, 'authorized', $3)
      ON CONFLICT (release_id) DO NOTHING
      RETURNING id, release_id, authorized_by, status,
                authorization_sha256, created_at
    `, [releaseId, String(telegramUserId), authorizationHash]);

    if (inserted.rowCount) {
      await client.query('COMMIT');
      return inserted.rows[0];
    }

    const existing = await client.query(`
      SELECT id, release_id, authorized_by, status,
             authorization_sha256, created_at
      FROM project_deployment_authorizations
      WHERE release_id = $1
    `, [releaseId]);
    await client.query('COMMIT');
    return existing.rows[0];
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  stableJson,
  buildReleaseReport,
  createImmutableReleaseArtifact,
  initProjectReleaseDatabase,
  createReleaseCandidate,
  getReleaseCandidate,
  decideRelease,
  authorizeDeployment
};
