'use strict';

const { generateText } = require('./ai-router');
const { validateBundle } = require('./ai-builder');
const { testProjectBundle } = require('./ai-tester');

function parseJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^\x60{3}(?:json)?\s*/i, '')
    .replace(/\s*\x60{3}$/, '');

  return JSON.parse(cleaned);
}

function canAttemptFix(testResult) {
  const sandbox = testResult?.sandbox;
  return testResult?.passed !== true &&
    sandbox?.executionStatus === 'completed' &&
    (sandbox.status === 'passed' || sandbox.repairable === true);
}

function originalFilesPreserved(originalBundle, candidateBundle) {
  const candidatePaths = new Set(candidateBundle.files.map(file => file.path));
  return originalBundle.files.every(file => candidatePaths.has(file.path));
}

function assertOriginalFilesPreserved(originalBundle, repairedBundle) {
  if (!originalFilesPreserved(originalBundle, repairedBundle)) {
    const repairedPaths = new Set(repairedBundle.files.map(file => file.path));
    const missing = originalBundle.files
      .map(file => file.path)
      .filter(filePath => !repairedPaths.has(filePath));
    throw new Error('AI FIXER حاول حذف ملفات أصلية: ' + missing.join(', '));
  }
}

async function fixProject({
  project,
  analysis,
  design,
  designArtifact,
  bundle,
  maxAttempts = 2,
  testRunner = testProjectBundle,
  generate = generateText
}) {
  if (!project || !analysis?.text || !design?.text) {
    throw new Error('يلزم وجود المشروع والتحليل والتصميم.');
  }

  const originalBundle = validateBundle(bundle);
  let currentBundle = originalBundle;

  const limit = Math.max(1, Math.min(2, Number(maxAttempts) || 2));
  const attempts = [];

  const systemInstruction = `
أنت AI FIXER في منصة BOSS BOT MASTER.

مهمتك إصلاح أخطاء المشروع التي اكتشفها AI TESTER.

قواعد إلزامية:
- أصلح الأخطاء الواردة في تقرير الاختبار فقط.
- حافظ على ميزات المشروع وسلوكه وتصميمه.
- حافظ على boss-design-map.json ومراجع التصميم المعتمد؛ لا تحذف أو تغيّر أي mapping إلا إذا كان تصحيح ملف فعلياً يتطلب ذلك، ويجب أن تبقى كل عناصر التصميم مرتبطة بملفات موجودة.
- لا تحذف ملفات أو ميزات لمجرد تجاوز الاختبار.
- لا تخترع مفاتيح API أو كلمات مرور أو بيانات سرية.
- لا تنشئ ملفات .env أو node_modules أو .git.
- لا تستخدم مسارات مطلقة أو مسارات تتجاوز مجلد المشروع.
- أعد جميع ملفات الحزمة، وليس الملفات المعدلة فقط.
- يجب أن تحتوي الحزمة على package.json.
- لا تدّعِ نجاح الاختبارات؛ سيعاد فحص الحزمة بشكل مستقل.
- أخرج JSON صالحاً فقط دون Markdown.

شكل الإخراج:
{
  "summary": "ملخص الإصلاح",
  "notes": [],
  "files": [
    {
      "path": "package.json",
      "content": "محتوى الملف كاملاً"
    }
  ]
}
`;

  for (let attempt = 1; attempt <= limit; attempt++) {
    const testResult = await testRunner({
      bundle: currentBundle,
      designArtifact
    });

    if (testResult.passed) {
      return {
        passed: true,
        bundle: currentBundle,
        attempts,
        testResult,
        originalPreserved: originalFilesPreserved(originalBundle, currentBundle),
        summary: 'اجتازت الحزمة الاختبارات.'
      };
    }

    if (!canAttemptFix(testResult)) {
      return {
        passed: false,
        bundle: currentBundle,
        attempts,
        testResult,
        originalPreserved: originalFilesPreserved(originalBundle, currentBundle),
        summary: 'توقف الإصلاح لأن تنفيذ الاختبارات لم يكتمل أو أن الفشل غير قابل للإصلاح الآلي.'
      };
    }

    const attemptInfo = {
      attempt,
      stage: 'repair',
      passed: false,
      errors: (testResult.checks || []).filter(c => !c.passed)
    };

    attempts.push(attemptInfo);

    const input = JSON.stringify({
      project: {
        id: project.project_id,
        name: project.project_name,
        businessType: project.business_type,
        specification: project.spec
      },
      analystReport: analysis.text,
      designDocument: design.text,
      designArtifact: designArtifact || design.artifact || null,
      currentFiles: currentBundle.files,
      testErrors: attemptInfo.errors
    });

    try {
      const response = await generate({ systemInstruction, input, stage:'fix', timeoutMs:180000 });
      let repaired;
      try { repaired = parseJson(response.text); }
      catch { throw new Error('نتيجة AI FIXER ليست JSON صالحاً.'); }
      attemptInfo.provider = response.provider;
      attemptInfo.model = response.model;

      const nextBundle = validateBundle(repaired);
      assertOriginalFilesPreserved(originalBundle, nextBundle);

      currentBundle = nextBundle;

      attemptInfo.repairSummary =
        String(repaired.summary || '').slice(0, 2000);

    } catch (error) {
      attemptInfo.repairError =
        String(error?.message || error).slice(0, 2000);

      continue;
    }
  }

  const finalTest = await testRunner({
    bundle: currentBundle,
    designArtifact
  });

  return {
    passed: finalTest.passed,
    bundle: currentBundle,
    attempts,
    testResult: finalTest,
    originalPreserved: originalFilesPreserved(originalBundle, currentBundle),
    summary: finalTest.passed
      ? 'تم الإصلاح واجتازت الحزمة الاختبارات.'
      : 'لم تنجح الاختبارات بعد ' + limit + ' محاولة إصلاح.'
  };
}

module.exports = { fixProject, canAttemptFix };
