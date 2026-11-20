'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validateSandboxImage, validateRuntimeNodeModules, ensureRuntimeMountPoint,
  hasProjectTests, parseTapSummary, verifyAcceptanceTestCases,
  buildSandboxArgs, runSandboxTests
} = require('../project-sandbox');

const TAP_PASS = [
  'TAP version 13',
  '# Subtest: [BOSS_ACCEPTANCE:main] approved scenario',
  'ok 1 - [BOSS_ACCEPTANCE:main] approved scenario',
  '1..1',
  '# tests 1',
  '# pass 1',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0'
].join('\n');
const IMAGE = 'node:22-alpine@sha256:' + 'a'.repeat(64);
const TAP_FAIL = [
  'TAP version 13',
  'not ok 1 - [BOSS_ACCEPTANCE:main] approved scenario',
  '  error: expected order to be saved',
  '1..1',
  '# tests 1',
  '# pass 0',
  '# fail 1',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0'
].join('\n');

test('sandbox requires immutable image digest', () => {
  assert.throws(() => validateSandboxImage('node:22-alpine'), /sha256 digest/);
  assert.equal(validateSandboxImage(IMAGE), IMAGE);
});
test('test discovery identifies supported test files', () => {
  assert.equal(hasProjectTests([{ path: 'index.js' }]), false);
  assert.equal(hasProjectTests([{ path: 'test/app.test.js' }]), true);
  assert.equal(hasProjectTests([{ path: 'src/app.spec.cjs' }]), true);
});
test('docker arguments enforce isolation and resource bounds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-'));
  try {
    const built = buildSandboxArgs({ projectDir: dir, image: IMAGE });
    assert.equal(built.timeout, 60000);
    for (const flag of ['--network=none', '--read-only', '--memory=256m', '--cpus=0.5', '--pids-limit=64', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pull=never']) {
      assert.ok(built.args.includes(flag), flag);
    }
    assert.ok(!built.args.includes('--privileged'));
    assert.ok(!built.args.includes('--network=host'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('no container is started when no tests exist', () => {
  let called = false;
  const result = runSandboxTests({ projectDir: '/not-used', files: [{ path: 'index.js' }], image: IMAGE, spawn: () => { called = true; } });
  assert.equal(result.status, 'skipped');
  assert.equal(called, false);
});
test('runner invokes isolated docker container without passing secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-'));
  try {
    let invocation;
    const result = runSandboxTests({
      projectDir: dir, files: [{ path: 'test/app.test.js' }], image: IMAGE,
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: TAP_PASS, stderr: '' };
      }
    });
    assert.equal(invocation.command, 'docker');
    assert.ok(invocation.args.includes('--network=none'));
    assert.ok(invocation.args.includes('--test-reporter=tap'));
    assert.equal(invocation.options.env.BOTS_ENCRYPTION_KEY, undefined);
    assert.equal(result.status, 'passed');
    assert.equal(result.executionStatus, 'completed');
    assert.equal(result.repairable, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('runtime mount point rejects bundled node_modules content', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-project-'));
  try {
    fs.mkdirSync(path.join(projectDir, 'node_modules'));
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'unexpected.js'), 'bad');
    assert.throws(() => ensureRuntimeMountPoint(projectDir), /must not contain files/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('runtime mount point rejects symlinked node_modules directories', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-project-link-'));
  const projectDir = path.join(parent, 'project');
  const target = path.join(parent, 'target');
  try {
    fs.mkdirSync(projectDir);
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(projectDir, 'node_modules'), 'dir');
    assert.throws(() => ensureRuntimeMountPoint(projectDir), /real directory/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('runner reports container failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-'));
  try {
    const result = runSandboxTests({
      projectDir: dir, files: [{ path: 'test/app.test.js' }], image: IMAGE,
      spawn: () => ({ status: 125, stdout: '', stderr: 'image unavailable' })
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.executionStatus, 'not_confirmed');
    assert.equal(result.repairable, false);
    assert.equal(result.passed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('runtime node_modules is mounted read-only at the project resolution path', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-project-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-runtime-'));
  try {
    const built = buildSandboxArgs({
      projectDir, image: IMAGE, runtimeNodeModulesDir: runtimeDir
    });
    const mountIndex = built.args.indexOf('--mount', built.args.indexOf('--mount') + 1);
    assert.ok(mountIndex >= 0);
    assert.equal(
      built.args[mountIndex + 1],
      'type=bind,src=' + fs.realpathSync(runtimeDir) + ',dst=/workspace/node_modules,readonly'
    );
    assert.equal(validateRuntimeNodeModules(runtimeDir), fs.realpathSync(runtimeDir));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('runtime node_modules rejects symlink roots', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-runtime-link-'));
  const target = path.join(parent, 'target');
  const link = path.join(parent, 'link');
  try {
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'dir');
    assert.throws(() => validateRuntimeNodeModules(link), /real directory/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('runner passes the verified runtime mount without exposing environment secrets', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-project-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-runtime-'));
  try {
    let invocation;
    const result = runSandboxTests({
      projectDir, runtimeNodeModulesDir: runtimeDir,
      files: [{ path: 'test/app.test.js' }], image: IMAGE,
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        assert.equal(fs.statSync(path.join(projectDir, 'node_modules')).isDirectory(), true);
        assert.deepEqual(fs.readdirSync(path.join(projectDir, 'node_modules')), []);
        return { status: 0, stdout: TAP_PASS, stderr: '' };
      }
    });
    assert.equal(invocation.command, 'docker');
    assert.ok(invocation.args.some(arg => arg.includes('dst=/workspace/node_modules,readonly')));
    assert.equal(invocation.options.env.BOTS_ENCRYPTION_KEY, undefined);
    assert.equal(result.status, 'passed');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});


test('TAP summary requires a non-empty fully passing test suite', () => {
  assert.deepEqual(parseTapSummary(TAP_PASS), {
    tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0,
    valid: true, allPassed: true
  });
  assert.equal(parseTapSummary(TAP_FAIL).valid, true);
  assert.equal(parseTapSummary(TAP_FAIL).allPassed, false);
  assert.equal(parseTapSummary('# tests 0\n# pass 0\n# fail 0').valid, false);
  assert.equal(parseTapSummary('# tests 2\n# pass 1\n# fail 1').valid, true);
  assert.equal(parseTapSummary('# tests 2\n# pass 1\n# fail 1').allPassed, false);
});

test('every approved acceptance marker must appear exactly once as a passing TAP test', () => {
  const required = [{
    acceptanceTestId: 'main',
    marker: '[BOSS_ACCEPTANCE:main]',
    testName: '[BOSS_ACCEPTANCE:main] approved scenario'
  }];
  assert.equal(verifyAcceptanceTestCases(TAP_PASS, required).passed, true);
  assert.equal(verifyAcceptanceTestCases(TAP_PASS, [
    {
      acceptanceTestId: 'missing',
      marker: '[BOSS_ACCEPTANCE:missing]',
      testName: '[BOSS_ACCEPTANCE:missing] missing scenario'
    }
  ]).passed, false);

  const failed = TAP_PASS.replace(
    'ok 1 - [BOSS_ACCEPTANCE:main]',
    'not ok 1 - [BOSS_ACCEPTANCE:main]'
  );
  assert.equal(verifyAcceptanceTestCases(failed, required).passed, false);
});

test('sandbox rejects a zero-test or malformed TAP report even when the process exits zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-'));
  try {
    const result = runSandboxTests({
      projectDir: dir, files: [{ path: 'test/app.test.js' }], image: IMAGE,
      spawn: () => ({
        status: 0,
        stdout: '# tests 0\n# pass 0\n# fail 0',
        stderr: ''
      })
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.passed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sandbox rejects a passing suite that omitted an approved acceptance test', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-'));
  try {
    const result = runSandboxTests({
      projectDir: dir,
      files: [{ path: 'test/app.test.js' }],
      image: IMAGE,
      requiredAcceptanceTests: [{
        acceptanceTestId: 'missing',
        marker: '[BOSS_ACCEPTANCE:missing]',
        testName: '[BOSS_ACCEPTANCE:missing] missing scenario'
      }],
      spawn: () => ({ status: 0, stdout: TAP_PASS, stderr: '' })
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.passed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('a completed TAP suite with failing assertions is repairable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-'));
  try {
    const result = runSandboxTests({
      projectDir: dir,
      files: [{ path: 'test/app.test.js' }],
      image: IMAGE,
      requiredAcceptanceTests: [{
        acceptanceTestId: 'main',
        marker: '[BOSS_ACCEPTANCE:main]',
        testName: '[BOSS_ACCEPTANCE:main] approved scenario'
      }],
      spawn: () => ({ status: 1, stdout: TAP_FAIL, stderr: '' })
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.executionStatus, 'completed');
    assert.equal(result.repairable, true);
    assert.equal(result.failureKind, 'test_cases_failed_or_not_run');
    assert.equal(result.testSummary.failed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skipped acceptance tests do not count as passing', () => {
  const skipped = TAP_PASS
    .replace('ok 1 - [BOSS_ACCEPTANCE:main] approved scenario',
      'ok 1 - [BOSS_ACCEPTANCE:main] approved scenario # SKIP')
    .replace('# pass 1', '# pass 0')
    .replace('# skipped 0', '# skipped 1');
  const result = verifyAcceptanceTestCases(skipped, [{
    acceptanceTestId: 'main',
    marker: '[BOSS_ACCEPTANCE:main]',
    testName: '[BOSS_ACCEPTANCE:main] approved scenario'
  }]);
  assert.equal(result.passed, false);
});
