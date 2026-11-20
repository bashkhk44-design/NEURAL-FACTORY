'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectDesignElements, validateDesignMap } = require('../build-design-map');

function fixture() {
  const designArtifact = {
    schemaVersion: 1,
    specVersion: 3,
    sourceFingerprint: 'a'.repeat(64),
    sourceRequirements: [{ id: 'SPEC_FEATURES' }],
    flows: [{
      id: 'main_flow',
      requirementRefs: ['SPEC_FEATURES'],
      steps: [{ id: 'show_items', requirementRefs: ['SPEC_FEATURES'] }]
    }],
    states: [{ id: 'start', requirementRefs: ['SPEC_FEATURES'] }],
    transitions: [{
      from: 'start', to: 'start', requirementRefs: ['SPEC_FEATURES']
    }],
    messages: [{ id: 'welcome', requirementRefs: ['SPEC_FEATURES'] }],
    buttons: [{ id: 'open', requirementRefs: ['SPEC_FEATURES'] }],
    errorStates: [{ id: 'failed', requirementRefs: ['SPEC_FEATURES'] }],
    acceptanceTests: [{ id: 'opens', requirementRefs: ['SPEC_FEATURES'] }]
  };
  const files = [
    { path: 'package.json', content: '{}' },
    { path: 'src/bot.js', content: '' },
    { path: 'test/acceptance.test.js', content: '' },
    { path: 'boss-design-map.json', content: '' }
  ];
  const mappings = collectDesignElements(designArtifact).map(item => ({
    ...item,
    filePaths: item.designType === 'acceptanceTest'
      ? ['src/bot.js', 'test/acceptance.test.js']
      : ['src/bot.js'],
    ...(item.designType === 'acceptanceTest'
      ? { testCases: [{
          filePath: 'test/acceptance.test.js',
          testName: '[BOSS_ACCEPTANCE:' + item.designId + '] opens approved feature'
        }] }
      : {})
  }));
  const map = {
    schemaVersion: 1,
    specVersion: 3,
    sourceFingerprint: 'a'.repeat(64),
    mappings
  };
  return { designArtifact, files, map };
}

test('accepts a complete design-to-file map tied to the approved fingerprint', () => {
  const input = fixture();
  const result = validateDesignMap(input);
  assert.equal(result.passed, true);
  assert.equal(result.mappedElements, 8);
  assert.equal(result.mappedFiles, 2);
  assert.equal(result.acceptanceTestCases.length, 1);
});

test('rejects omitted design elements', () => {
  const input = fixture();
  input.map.mappings.pop();
  assert.throws(() => validateDesignMap(input), /لم يربطها AI BUILDER/);
});

test('rejects invented design element IDs', () => {
  const input = fixture();
  input.map.mappings[0].designId = 'invented_feature';
  assert.throws(() => validateDesignMap(input), /غير معتمد/);
});

test('rejects file paths that are not in the generated bundle', () => {
  const input = fixture();
  input.map.mappings[0].filePaths = ['src/not-generated.js'];
  assert.throws(() => validateDesignMap(input), /مسار ملف غير موجود/);
});

test('rejects requirement references that differ from approved design', () => {
  const input = fixture();
  input.map.mappings[0].requirementRefs = ['SPEC_UNAPPROVED'];
  assert.throws(() => validateDesignMap(input), /لا تطابق التصميم المعتمد/);
});

test('rejects a map copied from another approved design version', () => {
  const input = fixture();
  input.map.sourceFingerprint = 'b'.repeat(64);
  assert.throws(() => validateDesignMap(input), /لا يطابق التصميم المعتمد/);
});


test('rejects an acceptance criterion without an executable test case', () => {
  const input = fixture();
  const acceptance = input.map.mappings.find(item => item.designType === 'acceptanceTest');
  delete acceptance.testCases;
  assert.throws(() => validateDesignMap(input), /حالات اختبار منفذة فعلياً/);
});

test('rejects an acceptance test case that points outside generated test files', () => {
  const input = fixture();
  const acceptance = input.map.mappings.find(item => item.designType === 'acceptanceTest');
  acceptance.testCases[0].filePath = 'src/bot.js';
  assert.throws(() => validateDesignMap(input), /حالة اختبار القبول غير صالحة/);
});
