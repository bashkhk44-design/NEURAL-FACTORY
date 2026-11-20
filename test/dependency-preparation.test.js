'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validatePackageManifest, validateEgressProxy, buildNpmArgs, prepareDependencyLock
} = require('../dependency-preparation');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-prep-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'safe-fixture',
    version: '1.0.0',
    dependencies: { 'is-number': '^7.0.0' },
    scripts: { start: 'node index.js' }
  }));
  return dir;
}

function generatedLock() {
  return {
    name: 'safe-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'safe-fixture', version: '1.0.0' },
      'node_modules/is-number': {
        version: '7.0.0',
        resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
        integrity: 'sha512-YWJjZA=='
      }
    }
  };
}

test('manifest preflight rejects lifecycle scripts before network access', () => {
  const result = validatePackageManifest({
    dependencies: { safe: '^1.0.0' },
    scripts: { postinstall: 'node steal.js' }
  });
  assert.equal(result.passed, false);
  assert.match(result.errors.join(' '), /postinstall/);
});

test('manifest preflight rejects URL, git, file, and workspace dependency sources', () => {
  for (const spec of [
    'https://attacker.invalid/pkg.tgz',
    'git+https://attacker.invalid/pkg.git',
    'file:../local-package',
    'workspace:*',
    'owner/repository',
    'owner/repository#main',
    'git@github.com:owner/repository.git'
  ]) {
    assert.equal(validatePackageManifest({ dependencies: { suspect: spec } }).passed, false);
  }
});

test('egress policy requires an explicit trusted proxy and registry-only policy', () => {
  assert.throws(() => validateEgressProxy('', 'registry.npmjs.org-only'), /PROXY/);
  assert.throws(() => validateEgressProxy('https://proxy.example', 'unrestricted'), /egress policy/);
  assert.throws(() => validateEgressProxy('https://user:pass@proxy.example', 'registry.npmjs.org-only'), /credentials/);
  assert.equal(
    validateEgressProxy('http://egress-proxy.internal:3128', 'registry.npmjs.org-only'),
    'http://egress-proxy.internal:3128/'
  );
});

test('npm command disables lifecycle scripts and routes registry traffic through the proxy', () => {
  const args = buildNpmArgs({
    projectDir: '/tmp/prep',
    proxy: 'http://egress-proxy.internal:3128'
  });
  assert.ok(args.includes('--ignore-scripts'));
  assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
  assert.ok(args.includes('--strict-ssl=true'));
  assert.ok(args.includes('--https-proxy=http://egress-proxy.internal:3128'));
});

test('preparation validates the npm result using a secret-free environment', () => {
  const dir = fixture();
  const output = path.join(dir, 'output', 'package-lock.json');
  let invocation;
  try {
    const result = prepareDependencyLock({
      projectDir: dir,
      outputFile: output,
      env: {
        PATH: process.env.PATH,
        BOSS_NPM_EGRESS_PROXY: 'http://egress-proxy.internal:3128',
        BOSS_NPM_EGRESS_POLICY: 'registry.npmjs.org-only',
        GEMINI_API_KEY: 'must-not-pass'
      },
      spawn(command, args, options) {
        invocation = { command, args, options };
        fs.writeFileSync(path.join(options.cwd, 'package-lock.json'),
          JSON.stringify(generatedLock()));
        return { status: 0, stdout: '', stderr: '' };
      }
    });
    assert.equal(result.passed, true);
    assert.equal(result.packageCount, 1);
    assert.equal(fs.existsSync(output), true);
    assert.equal(invocation.command, 'npm');
    assert.equal(invocation.options.env.GEMINI_API_KEY, undefined);
    assert.equal(invocation.options.env.npm_config_ignore_scripts, 'true');
    assert.equal(invocation.options.env.NO_PROXY, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preparation fails closed before invoking npm when trusted egress is absent', () => {
  const dir = fixture();
  let invoked = false;
  try {
    assert.throws(() => prepareDependencyLock({
      projectDir: dir,
      outputFile: path.join(dir, 'package-lock.json'),
      env: { PATH: process.env.PATH },
      spawn() { invoked = true; return { status: 0 }; }
    }), /egress policy/);
    assert.equal(invoked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
