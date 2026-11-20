'use strict';

const { validateBundle } = require('./ai-builder');
const { validateManifest } = require('./ai-tester');

function prepareDeployment({
  bundle,
  testResult,
  approved = false,
  configuredEnvNames = []
}) {
  const validated = validateBundle(bundle);
  const checks = [];
  const add = (name, passed, details = '') => {
    checks.push({ name, passed, details });
  };

  add(
    'tests-passed',
    testResult?.passed === true,
    testResult?.passed === true
      ? 'جميع الاختبارات المعلنة ناجحة.'
      : 'يجب نجاح الاختبارات قبل النشر.'
  );

  let packageData = {};
  let manifest = null;

  try {
    const packageFile = validated.files.find(f => f.path === 'package.json');
    if (!packageFile) throw new Error('package.json غير موجود.');

    packageData = JSON.parse(packageFile.content);
    if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) {
      throw new Error('package.json غير صالح.');
    }

    add('package-json', true);
  } catch (error) {
    add('package-json', false, error.message);
  }

  try {
    if (!testResult?.manifest) {
      throw new Error('نتيجة الاختبار لا تحتوي manifest صالحاً.');
    }

    manifest = validateManifest(testResult.manifest, packageData);
    add('manifest', true);
  } catch (error) {
    add('manifest', false, error.message);
  }

  const startScript = manifest
    ? packageData.scripts?.[manifest.startScript]
    : null;

  add(
    'start-script',
    typeof startScript === 'string' && startScript.trim().length > 0,
    startScript ? 'أمر التشغيل المحدد في manifest موجود.' : 'أمر التشغيل غير صالح.'
  );

  const configured = new Set(
    Array.isArray(configuredEnvNames)
      ? configuredEnvNames.filter(name =>
          typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(name)
        )
      : []
  );

  const required = manifest ? manifest.requiredEnv : [];
  const missingEnv = required.filter(name => !configured.has(name));

  add(
    'environment',
    Boolean(manifest) && missingEnv.length === 0,
    missingEnv.length
      ? 'متغيرات مطلوبة غير محفوظة لهذا المشروع: ' + missingEnv.join(', ')
      : manifest
        ? 'أسماء متغيرات البيئة المطلوبة محفوظة لهذا المشروع.'
        : 'تعذر التحقق من متغيرات البيئة دون manifest صالح.'
  );

  add(
    'admin-approval',
    approved === true,
    approved ? 'تم تمرير موافقة صريحة.' : 'بانتظار موافقة المدير.'
  );

  const ready = checks.every(check => check.passed);

  return {
    ready,
    deployed: false,
    approved: approved === true,
    checks,
    missingEnv,
    summary: ready
      ? 'المشروع جاهز مبدئياً لمرحلة ربط الاستضافة.'
      : 'المشروع غير جاهز للنشر؛ راجع الشروط غير الناجحة.'
  };
}

async function deployProject() {
  throw new Error(
    'النشر الفعلي غير مفعّل. يجب ربط مزوّد استضافة معتمد وموافقة المدير أولاً.'
  );
}

module.exports = {
  prepareDeployment,
  deployProject
};
