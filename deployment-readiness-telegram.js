'use strict';

const { evaluateDeploymentReadiness } = require('./deployment-readiness');
const {
  stableJson,
  sha256,
  computeDeploymentAuthorizationDigest
} = require('./deployment-preflight');

const BLOCKER_LABELS = Object.freeze({
  release_not_approved_or_invalid: 'الإصدار غير معتمد أو بياناته غير صالحة.',
  deployment_authorization_missing_or_mismatched: 'تصريح النشر المستقل مفقود أو لا يطابق الإصدار.',
  release_test_evidence_incomplete: 'أدلة الاختبارات أو اختبارات القبول غير مكتملة.',
  deployment_target_missing_or_unconfirmed: 'بيانات وجهة النشر غير محددة أو غير مؤكدة.',
  separate_execution_approval_missing_or_mismatched: 'الموافقة اليدوية المنفصلة على التنفيذ غير موجودة أو لا تطابق الوجهة.',
  deployment_checks_invalid_or_duplicated: 'قائمة فحوصات النشر غير صالحة أو تحتوي تكراراً.',
  'deployment_check_failed_or_missing:artifact_integrity': 'فحص سلامة الحزمة المعزولة لم يُنفذ أو لم ينجح.',
  'deployment_check_failed_or_missing:target_configured': 'فحص إعداد وجهة النشر لم يُنفذ أو لم ينجح.',
  'deployment_check_failed_or_missing:runtime_compatibility': 'فحص توافق إصدار Node.js لم يُنفذ أو لم ينجح.',
  'deployment_check_failed_or_missing:secrets_available': 'التحقق من أسماء متغيرات البيئة المطلوبة لم يُنفذ أو لم ينجح.',
  'deployment_check_failed_or_missing:rollback_plan': 'خطة الرجوع إلى إصدار سابق لم تُثبت.',
  'deployment_check_failed_or_missing:health_check': 'فحص تشغيل التطبيق ومسار الصحة داخل Docker لم يُنفذ أو لم ينجح.'
});

function reviewDeploymentReadiness({ release, authorization } = {}) {
  const artifactDigestValid = Boolean(
    release?.artifact &&
    /^[a-f0-9]{64}$/.test(String(release.artifact_sha256 || '')) &&
    sha256(stableJson(release.artifact)) === release.artifact_sha256
  );

  const authorizationDigestValid = Boolean(
    authorization &&
    release &&
    authorization.authorization_sha256 === computeDeploymentAuthorizationDigest({
      release,
      authorizedBy: authorization.authorized_by
    })
  );

  const readiness = evaluateDeploymentReadiness({
    release: artifactDigestValid ? release : { ...release, artifact_sha256: 'invalid' },
    authorization: authorizationDigestValid
      ? authorization
      : { ...authorization, status: 'invalid' },
    target: null,
    executionApproval: null,
    checks: []
  });

  return {
    artifactDigestValid,
    authorizationDigestValid,
    readiness,
    isolatedPreflightExecuted: false,
    executionAllowed: false,
    deployed: false
  };
}

function formatDeploymentReadinessReview({ release, review }) {
  const result = review || reviewDeploymentReadiness({ release });
  const labels = result.readiness.blockers.map(code =>
    BLOCKER_LABELS[code] || ('عائق غير مستوفى: ' + code)
  );

  const tests = release?.artifact?.report?.tests?.summary;
  const testLine = tests
    ? String(tests.passed ?? 0) + '/' + String(tests.tests ?? 0) +
      ' ناجحة | فشل: ' + String(tests.failed ?? 0) +
      ' | متجاوزة: ' + String(tests.skipped ?? 0)
    : 'لا يوجد ملخص اختبارات محفوظ';

  return [
    '📋 مراجعة متطلبات جاهزية النشر',
    '',
    'الإصدار: #' + String(release?.id ?? 'غير معروف') +
      ' | R' + String(release?.release_version ?? '?'),
    'المشروع: ' + String(release?.project_name || ('#' + String(release?.project_id ?? '?'))),
    'حالة الاعتماد: ' + (release?.status === 'approved' ? '✅ معتمد من العميل والمدير' : '⛔ غير معتمد'),
    'سلامة بصمة الحزمة: ' + (result.artifactDigestValid ? '✅ مطابقة' : '❌ غير مطابقة أو مفقودة'),
    'تصريح النشر المستقل: ' + (result.authorizationDigestValid ? '✅ صالح ومطابق' : '❌ مفقود أو غير صالح'),
    'نتيجة الاختبارات المسجلة: ' + testLine,
    '',
    'فحص Docker المعزول: ⏸️ لم يتم تشغيله من هذه المراجعة.',
    'وجهة النشر والموافقة اليدوية: لم يتم اعتمادهما بعد.',
    '',
    'العوائق الحالية:',
    ...(labels.length ? labels.map(label => '• ' + label) : ['• لا توجد عوائق مسجلة.']),
    '',
    'الجاهزية للمراجعة اليدوية النهائية: ' +
      (result.readiness.readyForManualExecutionReview ? '✅ نعم' : '❌ لا'),
    'السماح بالتنفيذ: ❌ لا',
    'تم النشر: ❌ لا',
    'بصمة المراجعة: ' + result.readiness.readinessSha256,
    '',
    'هذه مراجعة قراءة فقط. لا تشغّل Docker، ولا تتصل بمزود الاستضافة، ولا تقرأ قيم الأسرار، ولا تنفّذ أي نشر.'
  ].join('\n');
}

module.exports = {
  BLOCKER_LABELS,
  reviewDeploymentReadiness,
  formatDeploymentReadinessReview
};
