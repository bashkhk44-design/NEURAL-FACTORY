'use strict';

const { randomUUID } = require('node:crypto');
const { enqueuePlatformJob } = require('./platform-queue');
const {
  stableJson,
  sha256,
  computeDeploymentAuthorizationDigest
} = require('./deployment-preflight');

function validateReleaseAndAuthorization({ release, authorization, requestedBy }) {
  if (!release || !/^\d+$/.test(String(release.id || '')) ||
      !/^\d+$/.test(String(release.project_id || '')) ||
      release.status !== 'approved' || !release.artifact ||
      !/^[a-f0-9]{64}$/.test(String(release.artifact_sha256 || ''))) {
    throw new Error('Only an approved release with a valid immutable artifact can be queued.');
  }

  if (sha256(stableJson(release.artifact)) !== release.artifact_sha256) {
    throw new Error('Release artifact digest does not match its stored content.');
  }

  if (!authorization ||
      String(authorization.release_id) !== String(release.id) ||
      authorization.status !== 'authorized' ||
      !/^\d+$/.test(String(authorization.authorized_by || '')) ||
      authorization.authorization_sha256 !== computeDeploymentAuthorizationDigest({
        release,
        authorizedBy: authorization.authorized_by
      })) {
    throw new Error('A valid, matching deployment authorization is required.');
  }

  if (!/^\d+$/.test(String(requestedBy || ''))) {
    throw new Error('A valid Telegram manager ID is required.');
  }
  if (String(requestedBy) !== String(authorization.authorized_by)) {
    throw new Error('Only the manager who authorized this release can request its preflight.');
  }
}

async function enqueueDeploymentPreflight({
  pool,
  release,
  authorization,
  requestedBy
}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('PostgreSQL pool is required.');
  }
  validateReleaseAndAuthorization({ release, authorization, requestedBy });

  const owner = await pool.query(
    'SELECT client_id FROM client_projects WHERE id = $1 LIMIT 1',
    [release.project_id]
  );
  if (!owner.rowCount || !owner.rows[0].client_id) {
    throw new Error('The release project owner could not be verified.');
  }

  // Read environment variable NAMES only. Secret values are never selected or decrypted.
  const envResult = await pool.query(
    'SELECT env_name FROM project_secrets WHERE project_id = $1 ORDER BY env_name',
    [release.project_id]
  );
  const envNames = envResult.rows.map(row => String(row.env_name)).sort();
  const envNamesSha256 = sha256(stableJson(envNames));
  const active = await pool.query(`
    SELECT *
    FROM platform_jobs
    WHERE job_type = 'deployment.preflight'
      AND project_id = $1
      AND payload->>'releaseId' = $2
      AND payload->>'envNamesSha256' = $3
      AND status IN ('queued', 'processing', 'retrying')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [release.project_id, String(release.id), envNamesSha256]);
  if (active.rowCount) {
    return {
      created: false,
      job: active.rows[0],
      idempotencyKey: active.rows[0].idempotency_key,
      envNamesSha256
    };
  }

  // Completed/failed runs can be retried. An active-job lookup prevents ordinary repeated button presses from creating parallel runs.
  const idempotencyKey = [
    'deployment.preflight',
    String(release.id),
    release.artifact_sha256,
    envNamesSha256,
    randomUUID()
  ].join(':');

  const queued = await enqueuePlatformJob(pool, {
    jobType: 'deployment.preflight',
    clientId: owner.rows[0].client_id,
    projectId: release.project_id,
    idempotencyKey,
    priority: 10,
    maxAttempts: 3,
    payload: {
      releaseId: String(release.id),
      projectId: String(release.project_id),
      artifactSha256: release.artifact_sha256,
      envNamesSha256,
      requestedBy: String(requestedBy)
    }
  });

  return {
    ...queued,
    idempotencyKey,
    envNamesSha256
  };
}

async function getLatestDeploymentPreflightJob({ pool, releaseId, projectId }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('PostgreSQL pool is required.');
  }
  if (!/^\d+$/.test(String(releaseId || '')) ||
      !/^\d+$/.test(String(projectId || ''))) {
    throw new Error('Invalid release or project ID.');
  }

  const result = await pool.query(`
    SELECT id, status, attempts, max_attempts, last_error,
           payload->'result' AS result, created_at, updated_at
    FROM platform_jobs
    WHERE job_type = 'deployment.preflight'
      AND project_id = $1
      AND payload->>'releaseId' = $2
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [projectId, String(releaseId)]);

  return result.rows[0] || null;
}

const BLOCKER_LABELS = Object.freeze({
  deployment_target_missing_or_unconfirmed: 'بيانات وجهة النشر غير محددة أو غير مؤكدة.',
  separate_execution_approval_missing_or_mismatched: 'الموافقة اليدوية المنفصلة على التنفيذ غير موجودة أو لا تطابق الإصدار.',
  release_test_evidence_incomplete: 'أدلة اختبارات الإصدار غير مكتملة.',
  deployment_authorization_missing_or_mismatched: 'تصريح النشر المستقل غير صالح أو غير مطابق.',
  release_not_approved_or_invalid: 'الإصدار غير معتمد أو بياناته غير صالحة.',
  project_environment_names_changed_after_the_preflight_was_queued: 'تغيرت أسماء متغيرات البيئة بعد طلب الفحص.'
});

const CHECK_LABELS = Object.freeze({
  artifact_integrity: 'سلامة الحزمة',
  target_configured: 'وجهة النشر',
  runtime_compatibility: 'توافق Node.js',
  secrets_available: 'أسماء متغيرات البيئة',
  rollback_plan: 'خطة الرجوع',
  health_check: 'تشغيل التطبيق وفحص الصحة'
});

function formatDeploymentPreflightJob(job, release) {
  if (!job) return 'لا يوجد فحص Docker معزول مسجل لهذا الإصدار بعد.';
  const statusLabels = {
    queued: '⏳ بانتظار عامل الفحص',
    processing: '🔄 الفحص قيد التنفيذ',
    retrying: '🟠 سيعاد الفحص بعد تعثر العامل',
    completed: '✅ انتهى الفحص',
    failed: '❌ فشل الفحص',
    dead_letter: '⛔ توقف الفحص بعد استنفاد المحاولات',
    cancelled: 'تم إلغاء الفحص'
  };
  const lines = [
    '🧪 نتيجة فحص Docker المعزول',
    '',
    'الإصدار: #' + String(release?.id || '?') +
      ' | R' + String(release?.release_version || '?'),
    'مهمة الفحص: #' + String(job.id),
    'الحالة: ' + (statusLabels[job.status] || String(job.status)),
    'المحاولات: ' + String(job.attempts || 0) + '/' + String(job.max_attempts || 0)
  ];

  const result = job.result && typeof job.result === 'object' ? job.result : null;
  if (result) {
    lines.push(
      'محاولة الفحص المعزول: ' + (result.isolatedPreflightAttempted ? 'نعم' : 'لا'),
      'تشغيل الحاوية مؤكد: ' + (result.isolatedPreflightExecuted ? 'نعم' : 'لا'),
      'إصدار Node داخل الحاوية: ' + String(result.runtimeVersion || 'غير متحقق'),
      'مسار الصحة: ' + (result.dockerHealthProbePassed ? 'ناجح' : (result.healthStatus ? 'HTTP ' + result.healthStatus : 'لم ينجح'))
    );
    if (Array.isArray(result.checks)) {
      lines.push('', 'نتائج الفحوصات:');
      for (const check of result.checks) {
        const label = CHECK_LABELS[check.name] || check.name;
        lines.push(
          (check.passed ? '✅ ' : '❌ ') + label + ': ' +
          String(check.evidence || '').slice(0, 220)
        );
      }
    }
    if (Array.isArray(result.missingEnv) && result.missingEnv.length) {
      lines.push('', 'أسماء متغيرات غير مسجلة: ' + result.missingEnv.join(', '));
    }
    if (Array.isArray(result.blockers) && result.blockers.length) {
      lines.push('', 'ما زال يمنع الجاهزية النهائية:');
      for (const blocker of result.blockers.slice(0, 8)) lines.push('• ' + (BLOCKER_LABELS[blocker] || blocker));
    }
    lines.push(
      '',
      'الجاهزية للمراجعة اليدوية النهائية: ' +
        (result.readyForManualExecutionReview ? 'نعم' : 'لا'),
      'السماح بالتنفيذ: ❌ لا',
      'تم النشر: ❌ لا'
    );
  } else if (job.last_error) {
    lines.push('', 'تفاصيل التعثر: ' + String(job.last_error).slice(0, 700));
  } else {
    lines.push('', 'لم يسجل العامل نتيجة نهائية حتى الآن.');
  }

  lines.push(
    '',
    'هذا العامل يفحص الحزمة فقط. لا يتصل بمزود الاستضافة ولا يقرأ قيم الأسرار ولا ينفذ أي نشر.'
  );
  return lines.join('\n').slice(0, 3900);
}

module.exports = {
  validateReleaseAndAuthorization,
  enqueueDeploymentPreflight,
  getLatestDeploymentPreflightJob,
  formatDeploymentPreflightJob
};
