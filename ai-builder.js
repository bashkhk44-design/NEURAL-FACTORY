'use strict';

const { generateText } = require('./ai-router');
const {
  buildDesignSourceRequirements,
  normalizeDesignArtifact
} = require('./design-artifact');
const { validateDesignMap } = require('./build-design-map');

const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 1024 * 1024;

function parseJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^\x60{3}(?:json)?\s*/i, '')
    .replace(/\s*\x60{3}$/, '');
  return JSON.parse(cleaned);
}

function validateBundle(bundle) {
  if (!bundle || !Array.isArray(bundle.files)) {
    throw new Error('AI BUILDER لم يُرجع قائمة ملفات صالحة.');
  }
  if (bundle.files.length === 0 || bundle.files.length > MAX_FILES) {
    throw new Error('عدد الملفات الناتجة غير صالح.');
  }

  const seen = new Set();
  let totalBytes = 0;
  for (const file of bundle.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('يوجد ملف ناقص الاسم أو المحتوى.');
    }
    const filePath = file.path.trim();
    if (!filePath || filePath.startsWith('/') || filePath.includes('\\') ||
        filePath.split('/').some(part => !part || part === '.' || part === '..') ||
        /^[a-zA-Z]:/.test(filePath)) {
      throw new Error('مسار ملف غير آمن: ' + filePath);
    }
    const pathSegments = filePath.split('/');
    const containsSensitiveSegment = pathSegments.some(segment =>
      segment === '.git' ||
      segment === 'node_modules' ||
      segment === '.env' ||
      segment.startsWith('.env.') ||
      segment.startsWith('.env-') ||
      segment.startsWith('.env_') ||
      segment === '.envrc'
    );
    if (containsSensitiveSegment) {
      throw new Error('تم رفض مسار ملف حساس: ' + filePath);
    }
    if (seen.has(filePath)) throw new Error('مسار ملف مكرر: ' + filePath);
    seen.add(filePath);
    totalBytes += Buffer.byteLength(file.content, 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('حجم الحزمة تجاوز الحد المسموح.');
  }

  if (!seen.has('package.json')) throw new Error('الحزمة لا تحتوي على package.json.');
  return {
    files: bundle.files,
    summary: String(bundle.summary || '').slice(0, 5000),
    notes: Array.isArray(bundle.notes) ? bundle.notes.map(String).slice(0, 30) : []
  };
}

function validateBuildDesignContract({ bundle, designArtifact }) {
  const validated = validateBundle(bundle);
  const mapFile = validated.files.find(file => file.path === 'boss-design-map.json');
  if (!mapFile) throw new Error('الحزمة لا تحتوي على boss-design-map.json.');
  let map;
  try { map = JSON.parse(mapFile.content); }
  catch (error) { throw new Error('خريطة التصميم ليست JSON صالحاً: ' + error.message); }
  return validateDesignMap({
    map,
    designArtifact,
    files: validated.files
  });
}

async function buildProject({ project, analysis, design }) {
  if (!project || !project.spec || !analysis?.text || !design?.text || !design?.artifact) {
    throw new Error('يلزم وجود المواصفات والتحليل ووثيقة التصميم المنظمة والمعتمدة قبل البناء.');
  }

  const source = buildDesignSourceRequirements(project.spec, project.spec_version);
  const approvedDesign = normalizeDesignArtifact(design.artifact, source);
  if (approvedDesign.sourceFingerprint !== design.artifact.sourceFingerprint ||
      approvedDesign.specVersion !== Number(project.spec_version)) {
    throw new Error('وثيقة التصميم لا تطابق إصدار المواصفات المعتمد حالياً.');
  }

  const designElements = require('./build-design-map').collectDesignElements(approvedDesign);
  const mappingExample = {
    schemaVersion: 1,
    specVersion: approvedDesign.specVersion,
    sourceFingerprint: approvedDesign.sourceFingerprint,
    mappings: designElements.map(item => ({
      designType: item.designType,
      designId: item.designId,
      requirementRefs: item.requirementRefs,
      filePaths: item.designType === 'acceptanceTest'
        ? ['src/feature.js', 'test/acceptance.test.js']
        : ['src/feature.js'],
      ...(item.designType === 'acceptanceTest'
        ? { testCases: [{
            filePath: 'test/acceptance.test.js',
            testName: '[BOSS_ACCEPTANCE:' + item.designId + '] scenario'
          }] }
        : {})
    }))
  };

  const systemInstruction = [
    'أنت AI BUILDER في منصة BOSS BOT MASTER.',
    'حوّل المواصفات المعتمدة والتصميم المنظم المعتمد إلى حزمة ملفات برمجية.',
    'المصدر الوحيد للميزات هو designArtifact ومراجعه إلى approved source requirements.',
    'لا تضف ميزة أو تكاملاً أو دوراً أو سياسة غير موجودة في التصميم المعتمد.',
    'يجب تنفيذ كل عنصر في designArtifact وربطه بملف واحد أو أكثر موجود فعلياً في الحزمة.',
    'لكل acceptanceTest أنشئ حالة اختبار Node.js فعلية باستخدام node:test، واربطها في testCases بملف الاختبار واسم يبدأ حرفياً بالعلامة [BOSS_ACCEPTANCE:<designId>]. لا تكتفِ بكتابة وصف أو اختبار فارغ؛ اختبر السلوك المتوقع في acceptanceTest قدر الإمكان من خلال واجهات المشروع. جميع هذه الحالات ستنفذ داخل sandbox معزول.',
    'أنشئ boss-design-map.json مطابقاً تماماً للشكل التالي، مع mapping واحد لكل عنصر تصميم، بما في ذلك flow وstep وstate وtransition وmessage وbutton وerrorState وacceptanceTest:',
    JSON.stringify(mappingExample, null, 2),
    'استخدم أسماء designType وdesignId ومراجع requirementRefs كما هي تماماً في التصميم؛ لا تخترع أو تحذف أي عنصر.',
    'filePaths يجب أن تشير إلى ملفات موجودة فعلياً ضمن files، ولا تشر إلى boss-design-map.json نفسه.',
    'لكل mapping من النوع acceptanceTest أضف testCases: [{filePath, testName}]؛ يجب أن يكون الملف داخل مجلد test/ أو tests/، وأن يكون ضمن filePaths، وأن ينتهي بـ .test.js/.spec.js/.test.cjs/.spec.cjs/.test.mjs/.spec.mjs، وأن يبدأ testName بالعلامة [BOSS_ACCEPTANCE:<designId>]. اربط mapping أيضاً بملف التنفيذ الفعلي.',
    'يجب أن تطابق schemaVersion وspecVersion وsourceFingerprint التصميم المعتمد دون تغيير.',
    'لا تضع مفاتيح API أو كلمات مرور أو أسراراً داخل الملفات. استخدم متغيرات البيئة.',
    'لا تنشئ ملفات .env أو node_modules أو .git.',
    'أدرج package.json صالحاً مع scripts وdependencies اللازمة.',
    'أنشئ boss-manifest.json بجذر المشروع بالحقول: version=1, requiredEnv, optionalEnv, startScript, healthCheck الاختياري.',
    'requiredEnv وoptionalEnv أسماء متغيرات فقط دون قيم. startScript يجب أن يكون أمراً موجوداً في package.json scripts.',
    'لا تستخدم مسارات مطلقة أو تتجاوز مجلد المشروع. الحد الأقصى 50 ملفاً و1MB.',
    'إذا تعذر تنفيذ عنصر دون افتراض غير معتمد، اذكره في notes ولا تدّعِ تنفيذه. مع ذلك يجب أن يبقى التصميم كله ممثلاً في الخريطة، ويجب ألا يُقدّم البناء كجاهز إذا بقيت فجوة.',
    'لا تدّعِ أن المشروع اختُبر أو نُشر.',
    'أخرج JSON صالحاً فقط دون Markdown أو نص خارجه.',
    JSON.stringify({
      summary: 'ملخص البناء',
      notes: [],
      files: [
        { path: 'package.json', content: '{"name":"project","version":"1.0.0","scripts":{"start":"node src/index.js"}}' },
        { path: 'boss-manifest.json', content: '{"version":1,"requiredEnv":[],"optionalEnv":[],"startScript":"start","healthCheck":"/health"}' },
        { path: 'boss-design-map.json', content: JSON.stringify(mappingExample) },
        { path: 'src/index.js', content: '/* implementation */' }
      ]
    }, null, 2)
  ].join('\n');

  const input = JSON.stringify({
    project: {
      id: project.project_id,
      name: project.project_name,
      businessType: project.business_type,
      specification: project.spec,
      specVersion: source.specVersion
    },
    approvedRequirements: source.requirements,
    analystReport: analysis.text,
    designDocument: design.text,
    designArtifact: approvedDesign
  });

  const response = await generateText({
    systemInstruction, input, stage: 'build', timeoutMs: 180000
  });
  let parsed;
  try { parsed = parseJson(response.text); }
  catch { throw new Error('AI BUILDER أعاد نتيجة ليست JSON صالحاً من ' + response.provider + '.'); }

  const bundle = validateBundle(parsed);
  const designContract = validateBuildDesignContract({
    bundle,
    designArtifact: approvedDesign
  });

  return {
    ...bundle,
    designContract,
    designFingerprint: approvedDesign.sourceFingerprint,
    model: response.model,
    provider: response.provider,
    interactionId: response.interactionId || null,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildProject,
  validateBundle,
  validateBuildDesignContract
};
