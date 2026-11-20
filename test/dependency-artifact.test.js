'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  parseIntegrity, verifyTarballIntegrity, validateRegistryTarballUrl,
  buildPackArgs, prepareOfflineDependencyArtifact
} = require('../dependency-artifact');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-artifact-test-'));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  const archive = Buffer.from('safe test tarball bytes');
  const integrity = 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64');
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'artifact-fixture', version: '1.0.0', dependencies: { demo: '^1.0.0' }
  }));
  fs.writeFileSync(path.join(projectDir, 'package-lock.json'), JSON.stringify({
    name: 'artifact-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'artifact-fixture', version: '1.0.0' },
      'node_modules/demo': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
        integrity
      }
    }
  }));
  return { root, projectDir, archive, integrity };
}

function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  try { fs.chmodSync(dir, 0o700); } catch {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) removeTree(target);
    else {
      try { fs.chmodSync(target, 0o600); } catch {}
      fs.rmSync(target, { force: true });
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

test('SRI parser prefers the strongest supported digest', () => {
  const parsed = parseIntegrity('sha256-YWJj sha512-ZGVm');
  assert.equal(parsed[0].algorithm, 'sha512');
});

test('SRI verification rejects wrong bytes and symbolic links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sri-test-'));
  const file = path.join(dir, 'package.tgz');
  try {
    fs.writeFileSync(file, 'wrong');
    assert.throws(() => verifyTarballIntegrity(file, 'sha512-YWJjZA=='), /integrity check/);
    const link = path.join(dir, 'link.tgz');
    fs.symlinkSync(file, link);
    assert.throws(() => verifyTarballIntegrity(link, 'sha512-YWJjZA=='), /size limit/);
  } finally { removeTree(dir); }
});

test('only HTTPS npm registry tarball URLs are accepted', () => {
  assert.equal(validateRegistryTarballUrl('https://registry.npmjs.org/demo/-/demo-1.0.0.tgz'),
    'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz');
  for (const url of [
    'http://registry.npmjs.org/demo.tgz', 'https://evil.example/demo.tgz',
    'https://registry.npmjs.org.evil.example/demo.tgz',
    'https://user@registry.npmjs.org/demo.tgz', 'https://registry.npmjs.org:444/demo.tgz'
  ]) assert.throws(() => validateRegistryTarballUrl(url), /approved npm registry/);
});

test('npm pack is configured to ignore scripts and use the trusted proxy', () => {
  const args = buildPackArgs({
    tarballUrl: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
    destination: '/tmp/downloads', proxy: 'http://proxy.internal:3128'
  });
  assert.ok(args.includes('--ignore-scripts'));
  assert.ok(args.includes('--strict-ssl=true'));
  assert.ok(args.includes('--https-proxy=http://proxy.internal:3128'));
});

test('preparation creates a verified offline artifact and excludes application secrets', () => {
  const fixture = makeFixture();
  const outputDir = path.join(fixture.root, 'artifact');
  let invocation;
  try {
    const result = prepareOfflineDependencyArtifact({
      projectDir: fixture.projectDir, outputDir,
      env: {
        PATH: process.env.PATH,
        BOSS_NPM_EGRESS_PROXY: 'http://proxy.internal:3128',
        BOSS_NPM_EGRESS_POLICY: 'registry.npmjs.org-only',
        GEMINI_API_KEY: 'must-not-pass'
      },
      spawn(command, args, options) {
        invocation = { command, args, options };
        const destination = args.find(arg => arg.startsWith('--pack-destination=')).slice('--pack-destination='.length);
        fs.writeFileSync(path.join(destination, 'demo-1.0.0.tgz'), fixture.archive);
        return { status: 0, stdout: JSON.stringify([{ filename: 'demo-1.0.0.tgz' }]), stderr: '' };
      }
    });
    assert.equal(result.passed, true);
    assert.equal(result.packageCount, 1);
    assert.equal(fs.readFileSync(path.join(outputDir, 'packages', '0000.tgz')).equals(fixture.archive), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'artifact-manifest.json'), 'utf8'));
    assert.equal(manifest.format, 'boss-offline-dependencies-v1');
    assert.equal(manifest.packages[0].lockPath, 'node_modules/demo');
    assert.equal(invocation.command, 'npm');
    assert.equal(invocation.options.env.GEMINI_API_KEY, undefined);
    assert.equal(invocation.options.env.NO_PROXY, '');
  } finally { removeTree(fixture.root); }
});

test('preparation fails closed without registry-only proxy policy', () => {
  const fixture = makeFixture();
  try {
    assert.throws(() => prepareOfflineDependencyArtifact({
      projectDir: fixture.projectDir, outputDir: path.join(fixture.root, 'artifact'),
      env: { PATH: process.env.PATH }, spawn() { throw new Error('must not invoke npm'); }
    }), /registry-only egress policy/);
  } finally { removeTree(fixture.root); }
});

test('preparation rejects an integrity mismatch and leaves no artifact', () => {
  const fixture = makeFixture();
  const outputDir = path.join(fixture.root, 'artifact');
  try {
    assert.throws(() => prepareOfflineDependencyArtifact({
      projectDir: fixture.projectDir, outputDir,
      env: {
        PATH: process.env.PATH,
        BOSS_NPM_EGRESS_PROXY: 'http://proxy.internal:3128',
        BOSS_NPM_EGRESS_POLICY: 'registry.npmjs.org-only'
      },
      spawn(command, args) {
        const destination = args.find(arg => arg.startsWith('--pack-destination=')).slice('--pack-destination='.length);
        fs.writeFileSync(path.join(destination, 'bad.tgz'), 'tampered archive');
        return { status: 0, stdout: JSON.stringify([{ filename: 'bad.tgz' }]), stderr: '' };
      }
    }), /integrity check/);
    assert.equal(fs.existsSync(outputDir), false);
  } finally { removeTree(fixture.root); }
});
