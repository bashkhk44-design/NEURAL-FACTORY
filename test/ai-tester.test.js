'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testProjectBundle } = require('../ai-tester');
const { collectDesignElements } = require('../build-design-map');

function makeBundle(lockContent = JSON.stringify({
  name: 'fixture',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/demo': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64')
    }
  }
})) {
  return {
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'fixture',
          version: '1.0.0',
          scripts: { test: 'node --test' },
          dependencies: { demo: '1.0.0' }
        })
      },
      { path: 'package-lock.json', content: lockContent },
      {
        path: 'boss-manifest.json',
        content: JSON.stringify({
          version: 1,
          requiredEnv: [],
          optionalEnv: [],
          startScript: 'test'
        })
      },
      {
        path: 'test/app.test.js',
        content: "const test = require('node:test');\ntest('fixture', () => {});\n"
      }
    ]
  };
}

test('runtime test fails closed when locked dependencies have no verified artifact', async () => {
  const previousEnabled = process.env.BOSS_SANDBOX_ENABLED;
  const previousImage = process.env.BOSS_SANDBOX_IMAGE;
  process.env.BOSS_SANDBOX_ENABLED = 'YES';
  delete process.env.BOSS_SANDBOX_IMAGE;
  try {
    const result = await testProjectBundle({ bundle: makeBundle() });
    assert.equal(result.sandbox.status, 'failed');
    assert.equal(result.sandbox.passed, false);
    assert.match(result.sandbox.details, /verified offline dependency artifacts are required/i);
    assert.equal(result.passed, false);
  } finally {
    if (previousEnabled === undefined) delete process.env.BOSS_SANDBOX_ENABLED;
    else process.env.BOSS_SANDBOX_ENABLED = previousEnabled;
    if (previousImage === undefined) delete process.env.BOSS_SANDBOX_IMAGE;
    else process.env.BOSS_SANDBOX_IMAGE = previousImage;
  }
});

test('runtime test fails closed for malformed package-lock instead of throwing', async () => {
  const previousEnabled = process.env.BOSS_SANDBOX_ENABLED;
  const previousImage = process.env.BOSS_SANDBOX_IMAGE;
  process.env.BOSS_SANDBOX_ENABLED = 'YES';
  delete process.env.BOSS_SANDBOX_IMAGE;
  try {
    const result = await testProjectBundle({ bundle: makeBundle('{invalid-json') });
    assert.equal(result.sandbox.status, 'failed');
    assert.equal(result.sandbox.passed, false);
    assert.match(result.sandbox.details, /valid package-lock/i);
    assert.equal(result.passed, false);
  } finally {
    if (previousEnabled === undefined) delete process.env.BOSS_SANDBOX_ENABLED;
    else process.env.BOSS_SANDBOX_ENABLED = previousEnabled;
    if (previousImage === undefined) delete process.env.BOSS_SANDBOX_IMAGE;
    else process.env.BOSS_SANDBOX_IMAGE = previousImage;
  }
});


function makeDesignArtifact() {
  return {
    schemaVersion: 1,
    specVersion: 2,
    sourceFingerprint: 'c'.repeat(64),
    sourceRequirements: [{ id: 'SPEC_FEATURES' }],
    flows: [{
      id: 'main_flow',
      requirementRefs: ['SPEC_FEATURES'],
      steps: [{ id: 'start_step', requirementRefs: ['SPEC_FEATURES'] }]
    }],
    states: [{ id: 'start', requirementRefs: ['SPEC_FEATURES'] }],
    transitions: [],
    messages: [],
    buttons: [],
    errorStates: [],
    acceptanceTests: [{
      id: 'main_test',
      requirementRefs: ['SPEC_FEATURES']
    }]
  };
}

function addDesignMap(bundle, artifact) {
  const mappings = collectDesignElements(artifact).map(item => ({
    ...item,
    filePaths: ['test/app.test.js'],
    ...(item.designType === 'acceptanceTest'
      ? { testCases: [{
          filePath: 'test/app.test.js',
          testName: '[BOSS_ACCEPTANCE:' + item.designId + '] approved scenario'
        }] }
      : {})
  }));
  bundle.files.push({
    path: 'boss-design-map.json',
    content: JSON.stringify({
      schemaVersion: 1,
      specVersion: artifact.specVersion,
      sourceFingerprint: artifact.sourceFingerprint,
      mappings
    })
  });
  return bundle;
}

test('tester validates the complete design map but does not pass while sandbox is disabled', async () => {
  const artifact = makeDesignArtifact();
  const bundle = addDesignMap(makeBundle(), artifact);
  const result = await testProjectBundle({ bundle, designArtifact: artifact });

  assert.equal(result.passed, false);
  assert.equal(result.designFingerprint, artifact.sourceFingerprint);
  assert.equal(result.checks.find(item => item.name === 'design-to-file-map').passed, true);
  assert.equal(result.sandbox.status, 'disabled');
  assert.equal(result.checks.find(item => item.name === 'sandbox-runtime-tests').passed, false);
});

test('tester rejects a missing design mapping before the project can pass', async () => {
  const artifact = makeDesignArtifact();
  const bundle = addDesignMap(makeBundle(), artifact);
  const mapFile = bundle.files.find(file => file.path === 'boss-design-map.json');
  const map = JSON.parse(mapFile.content);
  map.mappings.pop();
  mapFile.content = JSON.stringify(map);

  const result = await testProjectBundle({ bundle, designArtifact: artifact });

  assert.equal(result.passed, false);
  assert.equal(result.checks.find(item => item.name === 'design-to-file-map').passed, false);
});


test('tester fails closed when no approved design artifact is supplied', async () => {
  const previousEnabled = process.env.BOSS_SANDBOX_ENABLED;
  delete process.env.BOSS_SANDBOX_ENABLED;
  try {
    const result = await testProjectBundle({ bundle: addDesignMap(makeBundle(), makeDesignArtifact()) });
    assert.equal(result.passed, false);
    assert.equal(result.checks.find(item => item.name === 'design-to-file-map').passed, false);
    assert.equal(result.sandbox.status, 'disabled');
  } finally {
    if (previousEnabled === undefined) delete process.env.BOSS_SANDBOX_ENABLED;
    else process.env.BOSS_SANDBOX_ENABLED = previousEnabled;
  }
});
