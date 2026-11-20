'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDesignSourceRequirements,
  normalizeDesignArtifact,
  renderDesignDocument
} = require('../design-artifact');

function validArtifact() {
  return {
    flows: [{
      id: 'order_flow',
      title: 'طلب منتج',
      goal: 'استعراض المنتجات وإرسال طلب',
      requirementRefs: ['SPEC_DESCRIPTION', 'SPEC_FEATURES'],
      steps: [{
        id: 'show_products',
        actor: 'العميل',
        action: 'طلب عرض المنتجات',
        response: 'يعرض البوت المنتجات المتاحة',
        requirementRefs: ['SPEC_FEATURES']
      }]
    }],
    states: [
      { id: 'start', name: 'البداية', description: 'انتظار طلب العميل', requirementRefs: ['SPEC_DESCRIPTION'] },
      { id: 'products', name: 'المنتجات', description: 'عرض المنتجات', requirementRefs: ['SPEC_FEATURES'] }
    ],
    transitions: [{
      from: 'start',
      to: 'products',
      trigger: 'اختيار عرض المنتجات',
      requirementRefs: ['SPEC_FEATURES']
    }],
    messages: [{
      id: 'welcome',
      when: 'عند البداية',
      text: 'أهلاً بك',
      requirementRefs: ['SPEC_DESCRIPTION']
    }],
    buttons: [{
      id: 'products_button',
      label: 'عرض المنتجات',
      action: 'فتح قائمة المنتجات',
      requirementRefs: ['SPEC_BUTTONS', 'SPEC_FEATURES']
    }],
    errorStates: [{
      id: 'empty_products',
      condition: 'لا توجد منتجات',
      message: 'لا توجد منتجات حالياً',
      recovery: 'العودة للقائمة الرئيسية',
      requirementRefs: ['SPEC_FEATURES']
    }],
    acceptanceTests: [{
      id: 'products_visible',
      scenario: 'يفتح العميل قائمة المنتجات',
      expected: 'تظهر المنتجات المتاحة فقط',
      requirementRefs: ['SPEC_FEATURES']
    }],
    openQuestions: []
  };
}

test('builds stable source IDs and fingerprint from approved specification', () => {
  const source = buildDesignSourceRequirements({
    description: 'متجر ملابس',
    features: 'عرض المنتجات',
    buttons: 'قائمة المنتجات'
  }, 4);

  assert.equal(source.schemaVersion, 1);
  assert.equal(source.specVersion, 4);
  assert.match(source.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(source.requirements.map((item) => item.id), [
    'SPEC_DESCRIPTION', 'SPEC_FEATURES', 'SPEC_BUTTONS'
  ]);
});

test('rejects design elements that reference invented requirements', () => {
  const source = buildDesignSourceRequirements({
    description: 'متجر ملابس',
    features: 'عرض المنتجات',
    buttons: 'قائمة المنتجات'
  }, 2);
  const artifact = validArtifact();
  artifact.messages[0].requirementRefs = ['SPEC_AUTOMATIC_DISCOUNT'];

  assert.throws(
    () => normalizeDesignArtifact(artifact, source),
    /غير موجود أو غير معتمد/
  );
});

test('rejects a design that does not cover every approved source requirement', () => {
  const source = buildDesignSourceRequirements({
    description: 'متجر ملابس',
    features: 'عرض المنتجات',
    buttons: 'قائمة المنتجات',
    payments: 'لا يوجد'
  }, 2);
  const artifact = validArtifact();

  assert.throws(
    () => normalizeDesignArtifact(artifact, source),
    /لم يغطِّ جميع المتطلبات/
  );
});

test('rejects transitions to unknown states', () => {
  const source = buildDesignSourceRequirements({
    description: 'متجر ملابس',
    features: 'عرض المنتجات',
    buttons: 'قائمة المنتجات'
  }, 1);
  const artifact = validArtifact();
  artifact.transitions[0].to = 'missing_state';

  assert.throws(
    () => normalizeDesignArtifact(artifact, source),
    /حالة غير معرفة/
  );
});

test('normalizes a versioned artifact and renders traceable document', () => {
  const source = buildDesignSourceRequirements({
    description: 'متجر ملابس',
    features: 'عرض المنتجات',
    buttons: 'قائمة المنتجات'
  }, 7);
  const artifact = normalizeDesignArtifact(validArtifact(), source);
  const document = renderDesignDocument(artifact);

  assert.equal(artifact.specVersion, 7);
  assert.equal(artifact.sourceFingerprint, source.sourceFingerprint);
  assert.equal(artifact.sourceRequirements.length, 3);
  assert.match(document, /SPEC_FEATURES/);
  assert.match(document, /اختبارات القبول/);
  assert.match(document, /لا يبدأ البناء قبل اعتماد التصميم/);
});

test('rejects design collections that are not arrays', () => {
  const source = buildDesignSourceRequirements({
    description: 'متجر ملابس',
    features: 'عرض المنتجات',
    buttons: 'قائمة المنتجات'
  }, 1);
  const artifact = validArtifact();
  artifact.buttons = null;

  assert.throws(
    () => normalizeDesignArtifact(artifact, source),
    /قائمة عناصر التصميم غير صالحة/
  );
});
