'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FACTORY_ARCHITECTURE,
  extractJson,
  normalizeIntakeResult
} = require('../ai-intake');

test('AI intake parses plain JSON and fenced JSON', () => {
  assert.deepEqual(extractJson('{"ready_for_review":true}'), { ready_for_review: true });
  assert.deepEqual(extractJson('```json\n{"ready_for_review":false}\n```'), { ready_for_review: false });
});

test('AI intake rejects malformed or missing JSON', () => {
  assert.throws(() => extractJson('لا يوجد JSON'));
  assert.throws(() => extractJson('{"broken":'));
});

test('AI intake merges only allowed non-empty string fields', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'ما طريقة استقبال الطلبات؟',
    fields: {
      description: 'متجر إلكتروني',
      features: 'عرض المنتجات',
      unexpected: 'must not be saved',
      payments: 123,
      extra: ''
    },
    missing_items: ['تحديد التوصيل'],
    ready_for_review: false
  }, {
    projectName: 'متجري',
    buttons: 'تصفح'
  });

  assert.equal(result.data.projectName, 'متجري');
  assert.equal(result.data.buttons, 'تصفح');
  assert.equal(result.data.description, 'متجر إلكتروني');
  assert.equal(result.data.features, 'عرض المنتجات');
  assert.equal(result.data.unexpected, undefined);
  assert.equal(result.data.payments, undefined);
  assert.deepEqual(result.missingItems, ['تحديد التوصيل']);
  assert.equal(result.readyForReview, false);
});

test('AI intake cannot finish while missing items remain', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'ما زالت هناك نقطة تحتاج توضيحاً.',
    fields: {},
    missing_items: ['تحديد صلاحيات الموظفين'],
    ready_for_review: true
  });
  assert.equal(result.readyForReview, false);
  assert.ok(result.missingItems.includes('تحديد صلاحيات الموظفين'));
  assert.ok(result.missingItems.includes('تحديد هدف المشروع وطريقة عمله'));
  assert.ok(result.missingItems.includes('تحديد الوظائف الأساسية المطلوبة'));
  assert.match(result.assistantMessage, /ما المهمة الأساسية/);
});

test('AI intake cannot finish without a project goal and core features', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'ما الهدف الأساسي من البوت وما الوظائف التي تريدها؟',
    fields: { description: 'بوت لمتجر' },
    missing_items: [],
    ready_for_review: true
  });
  assert.equal(result.readyForReview, false);
});

test('AI intake requires a customer-facing next message', () => {
  assert.throws(
    () => normalizeIntakeResult({ fields: {}, ready_for_review: true }),
    /missing its next message/
  );
});


test('AI intake readiness is blocked until the customer journey is explicit', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'اكتمل الطلب.',
    fields: {
      description: 'بوت لمتجر ملابس',
      features: 'عرض المنتجات واستقبال الطلبات'
    },
    missing_items: [],
    ready_for_review: true
  });

  assert.equal(result.readyForReview, false);
  assert.match(result.assistantMessage, /يتفاعل العميل/);
  assert.deepEqual(result.missingItems, [
    'تحديد رحلة العميل والأزرار أو توضيح أن التفاعل نصي دون قوائم'
  ]);
});

test('AI intake accepts an explicit text-only customer journey', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'اكتمل جمع المتطلبات ويمكنك مراجعتها.',
    fields: {
      description: 'بوت دعم فني',
      features: 'الإجابة عن الأسئلة الشائعة',
      buttons: 'غير مطلوب؛ المحادثة نصية بالكامل'
    },
    missing_items: [],
    ready_for_review: true
  });

  assert.equal(result.readyForReview, true);
  assert.deepEqual(result.missingItems, []);
});

test('AI intake preserves model gaps and adds deterministic required gaps', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'ما طريقة العمل؟',
    fields: { description: 'بوت حجوزات' },
    missing_items: ['تحديد سياسة الإلغاء'],
    ready_for_review: false
  });

  assert.equal(result.readyForReview, false);
  assert.deepEqual(result.missingItems, [
    'تحديد سياسة الإلغاء',
    'تحديد الوظائف الأساسية المطلوبة',
    'تحديد رحلة العميل والأزرار أو توضيح أن التفاعل نصي دون قوائم'
  ]);
});


test('AI intake asks about a model-reported gap instead of claiming completion', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'اكتمل جمع المتطلبات.',
    fields: {
      description: 'بوت حجوزات',
      features: 'إنشاء وإلغاء الحجوزات',
      buttons: 'اختيار الموعد وتأكيد الحجز'
    },
    missing_items: ['تحديد سياسة الإلغاء'],
    ready_for_review: true
  });

  assert.equal(result.readyForReview, false);
  assert.match(result.assistantMessage, /تحديد سياسة الإلغاء/);
  assert.match(result.assistantMessage, /ما التفاصيل/);
});


test('AI intake always applies the platform hybrid hosting and optional admin policy', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'ما الوظائف المطلوبة؟',
    fields: { description: 'متجر', factoryArchitecture: { hostingModel: 'customer', adminPanel: 'required' } },
    missing_items: [],
    ready_for_review: false
  }, {
    factoryArchitecture: { hostingModel: 'factory', adminPanel: 'disabled' }
  });

  assert.deepEqual(FACTORY_ARCHITECTURE, {
    hostingModel: 'hybrid',
    adminPanel: 'optional'
  });
  assert.deepEqual(result.data.factoryArchitecture, FACTORY_ARCHITECTURE);
});
