'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBuildDesignContract, validateBundle } = require('../ai-builder');
const { collectDesignElements } = require('../build-design-map');

function fixture() {
  const designArtifact = {
    schemaVersion: 1,
    specVersion: 2,
    sourceFingerprint: 'd'.repeat(64),
    sourceRequirements: [{ id: 'SPEC_FEATURES' }],
    flows: [{
      id: 'main_flow',
      requirementRefs: ['SPEC_FEATURES'],
      steps: [{ id: 'step_one', requirementRefs: ['SPEC_FEATURES'] }]
    }],
    states: [{ id: 'start', requirementRefs: ['SPEC_FEATURES'] }],
    transitions: [],
    messages: [],
    buttons: [],
    errorStates: [],
    acceptanceTests: [{ id: 'acceptance_one', requirementRefs: ['SPEC_FEATURES'] }]
  };
  const files = [
    { path: 'package.json', content: '{}' },
    { path: 'src/index.js', content: 'module.exports = true;' },
    { path: 'test/acceptance.test.js', content: "const test = require('node:test');\ntest('[BOSS_ACCEPTANCE:acceptance_one] scenario', () => {});\n" }
  ];
  const mappings = collectDesignElements(designArtifact).map(item => ({
    ...item,
    filePaths: item.designType === 'acceptanceTest'
      ? ['src/index.js', 'test/acceptance.test.js']
      : ['src/index.js'],
    ...(item.designType === 'acceptanceTest'
      ? { testCases: [{
          filePath: 'test/acceptance.test.js',
          testName: '[BOSS_ACCEPTANCE:' + item.designId + '] scenario'
        }] }
      : {})
  }));
  files.push({
    path: 'boss-design-map.json',
    content: JSON.stringify({
      schemaVersion: 1,
      specVersion: 2,
      sourceFingerprint: designArtifact.sourceFingerprint,
      mappings
    })
  });
  return { designArtifact, bundle: { files } };
}

test('AI Builder accepts a complete bundle mapped to the approved design', () => {
  const input = fixture();
  const result = validateBuildDesignContract(input);
  assert.equal(result.passed, true);
  assert.equal(result.mappedElements, 4);
});

test('AI Builder rejects a bundle without its design map', () => {
  const input = fixture();
  input.bundle.files = input.bundle.files.filter(file => file.path !== 'boss-design-map.json');
  assert.throws(() => validateBuildDesignContract(input), /boss-design-map.json/);
});

test('AI Builder rejects design maps copied from a different spec version', () => {
  const input = fixture();
  const mapFile = input.bundle.files.find(file => file.path === 'boss-design-map.json');
  const map = JSON.parse(mapFile.content);
  map.specVersion = 1;
  mapFile.content = JSON.stringify(map);
  assert.throws(() => validateBuildDesignContract(input), /لا يطابق التصميم المعتمد/);
});

test('AI Builder rejects root and nested environment secret files', () => {
  for (const path of [
    '.env',
    '.env.local',
    '.env.production',
    '.env-platform',
    '.envrc',
    'config/.env',
    'config/.env.local'
  ]) {
    assert.throws(
      () => validateBundle({
        files: [
          { path: 'package.json', content: '{}' },
          { path, content: 'SECRET=value' }
        ]
      }),
      /تم رفض مسار ملف حساس/
    );
  }
});

test('AI Builder still accepts ordinary source and documentation files', () => {
  const result = validateBundle({
    files: [
      { path: 'package.json', content: '{}' },
      { path: 'src/index.js', content: 'module.exports = true;' },
      { path: 'docs/setup.md', content: 'Setup instructions' }
    ]
  });
  assert.equal(result.files.length, 3);
});
