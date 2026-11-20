'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBundle } = require('../ai-builder');
const { validateManifest, scanForEmbeddedSecrets, testProjectBundle } = require('../ai-tester');
const { providers, getGeminiModel } = require('../ai-router');
const { advanceFallbackIntake } = require('../ai-intake');

function validBundle() {
  return {
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'sample-bot',
          version: '1.0.0',
          scripts: { start: 'node index.js' }
        })
      },
      {
        path: 'package-lock.json',
        content: JSON.stringify({
          name: 'sample-bot',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'sample-bot', version: '1.0.0' } }
        })
      },
      {
        path: 'boss-manifest.json',
        content: JSON.stringify({
          version: 1,
          requiredEnv: [],
          optionalEnv: [],
          startScript: 'start',
          healthCheck: '/health'
        })
      },
      { path: 'index.js', content: "console.log('sample');" }
    ]
  };
}

test('bundle validation accepts a safe project bundle', () => {
  assert.equal(validateBundle(validBundle()).files.length, 4);
});

test('bundle validation rejects path traversal', () => {
  const bundle = validBundle();
  bundle.files.push({ path: '../escape.js', content: 'x' });
  assert.throws(() => validateBundle(bundle), /مسار ملف غير آمن/);
});

test('manifest validation checks the declared start script', () => {
  const pkg = { scripts: { start: 'node index.js' } };
  const manifest = {
    version: 1, requiredEnv: ['DATABASE_URL'], optionalEnv: [],
    startScript: 'start', healthCheck: '/health'
  };
  assert.equal(validateManifest(manifest, pkg).startScript, 'start');
  assert.throws(() => validateManifest({ ...manifest, startScript: 'missing' }, pkg), /غير موجود/);
});

test('secret scanner detects embedded Telegram credentials', () => {
  const findings = scanForEmbeddedSecrets([
    { path: 'index.js', content: 'const token = "12345678:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk";' }
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'TELEGRAM_BOT_TOKEN');
});

test('static checks pass but release readiness fails closed without approved design and sandbox execution', async () => {
  const result = await testProjectBundle({ bundle: validBundle() });
  assert.equal(result.passed, false, JSON.stringify(result.checks));
  assert.equal(result.checks.find(check => check.name === 'dependency-preflight').passed, true);
  assert.equal(result.checks.find(check => check.name === 'design-to-file-map').passed, false);
  assert.equal(result.checks.find(check => check.name === 'sandbox-runtime-tests').passed, false);
});

test('project bundle without a lockfile fails closed', async () => {
  const bundle = validBundle();
  bundle.files = bundle.files.filter(file => file.path !== 'package-lock.json');
  const result = await testProjectBundle({ bundle });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(check => check.name === 'dependency-preflight').passed, false);
});

test('alternative AI providers require explicit opt-in', () => {
  const names = [
    'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FREE_MODEL', 'GROQ_API_KEY',
    'OPENROUTER_API_KEY', 'AI_ENABLE_GROQ_FREE', 'AI_ENABLE_OPENROUTER'
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.GEMINI_API_KEY = 'test-gemini';
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    delete process.env.GEMINI_FREE_MODEL;
    process.env.GROQ_API_KEY = 'test-groq';
    process.env.OPENROUTER_API_KEY = 'test-openrouter';
    delete process.env.AI_ENABLE_GROQ_FREE;
    delete process.env.AI_ENABLE_OPENROUTER;
    assert.deepEqual(providers().map(provider => provider.id), ['gemini']);
    assert.equal(getGeminiModel(), 'gemini-3.8-flash');
    assert.equal(providers()[0].model, getGeminiModel());
    delete process.env.GEMINI_MODEL;
    process.env.GEMINI_FREE_MODEL = 'gemini-3.8-flash';
    assert.equal(getGeminiModel(), 'gemini-3.8-flash');
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.GEMINI_FREE_MODEL = 'unsupported-model';
    assert.equal(getGeminiModel(), 'gemini-3.8-flash');
    process.env.GEMINI_MODEL = 'unsupported-model';
    assert.equal(providers()[0].model, 'gemini-3.8-flash');
    process.env.AI_ENABLE_GROQ_FREE = 'true';
    process.env.AI_ENABLE_OPENROUTER = 'true';
    assert.deepEqual(providers().map(provider => provider.id), ['gemini', 'groq', 'openrouter']);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('AI intake fallback collects requirements one question at a time without AI', () => {
  let state = advanceFallbackIntake({ aiFallback: true, fallbackField: 'description' });
  assert.equal(state.data.fallbackField, 'description');
  assert.match(state.assistantMessage, /اشرح فكرة المشروع/);
  state = advanceFallbackIntake(state.data, 'متجر على تيليغرام');
  assert.equal(state.data.description, 'متجر على تيليغرام');
  assert.equal(state.data.fallbackField, 'features');
  state = advanceFallbackIntake(state.data, 'عرض المنتجات واستقبال الطلبات');
  state = advanceFallbackIntake(state.data, 'زر عرض المنتجات وزر طلب شراء');
  state = advanceFallbackIntake(state.data, 'لا يوجد');
  state = advanceFallbackIntake(state.data, 'العربية');
  state = advanceFallbackIntake(state.data, 'لا يوجد');
  assert.equal(state.readyForReview, true);
  assert.equal(state.data.aiFallback, false);
  assert.equal(state.data.description, 'متجر على تيليغرام');
  assert.equal(state.data.features, 'عرض المنتجات واستقبال الطلبات');
});

test('AI fallback preserves the message that triggered provider failure', () => {
  const state = advanceFallbackIntake(
    { projectName: 'مطعم مرهف', businessType: 'restaurant', platform: 'telegram' },
    'نظام طلبات طعام مع التوصيل'
  );
  assert.equal(state.data.description, 'نظام طلبات طعام مع التوصيل');
  assert.equal(state.data.projectName, 'مطعم مرهف');
  assert.equal(state.data.businessType, 'restaurant');
  assert.equal(state.data.fallbackField, 'features');
  assert.match(state.assistantMessage, /أهم الميزات/);
});

test('AI fallback skips already collected fields and never overwrites them', () => {
  const state = advanceFallbackIntake({
    aiFallback: true, fallbackField: 'description',
    description: 'وصف محفوظ من المحلل', features: 'ميزات محفوظة من المحلل'
  }, 'أزرار قائمة الطعام والسلة وتتبع الطلب');
  assert.equal(state.data.description, 'وصف محفوظ من المحلل');
  assert.equal(state.data.features, 'ميزات محفوظة من المحلل');
  assert.equal(state.data.buttons, 'أزرار قائمة الطعام والسلة وتتبع الطلب');
  assert.equal(state.data.fallbackField, 'payments');
});

test('AI fallback can finish immediately when all required sections are already present', () => {
  const state = advanceFallbackIntake({
    description: 'وصف', features: 'ميزات', buttons: 'أزرار',
    payments: 'لا يوجد', languagesDesign: 'العربية', extra: 'لا يوجد'
  });
  assert.equal(state.readyForReview, true);
  assert.equal(state.data.aiFallback, false);
  assert.equal(state.data.fallbackField, undefined);
});
