'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildVerifiedDependencyManifest } = require('../dependency-artifact-manifest');

function fixture() {
  const bytes = Buffer.from('trusted package tarball fixture');
  const integrity = 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
  return {
    bytes,
    lockData: {
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/is-number': {
          version: '7.0.0',
          resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
          integrity
        }
      }
    },
    tarballs: { 'node_modules/is-number': bytes }
  };
}

test('builds a deterministic manifest after verifying the npm integrity hash', () => {
  const f = fixture();
  const result = buildVerifiedDependencyManifest(f);
  assert.equal(result.format, 'boss-dependency-artifact-manifest');
  assert.equal(result.packageCount, 1);
  assert.equal(result.totalBytes, f.bytes.length);
  assert.equal(result.packages[0].sha256,
    crypto.createHash('sha256').update(f.bytes).digest('hex'));
});

test('parses multiple SRI tokens and rejects digest lengths that do not match the algorithm', () => {
  const f = fixture();
  const sha256 = crypto.createHash('sha256').update(f.bytes).digest('base64');
  const sha512 = crypto.createHash('sha512').update(f.bytes).digest('base64');
  const lockData = structuredClone(f.lockData);
  lockData.packages['node_modules/is-number'].integrity = 'sha256-' + sha256 + ' sha512-' + sha512;
  assert.equal(buildVerifiedDependencyManifest({ ...f, lockData }).packageCount, 1);

  lockData.packages['node_modules/is-number'].integrity = 'sha512-' + Buffer.from('short').toString('base64');
  assert.throws(() => buildVerifiedDependencyManifest({ ...f, lockData }), /Malformed integrity digest/);
});

test('rejects missing, unexpected, and modified tarballs', () => {
  const f = fixture();
  assert.throws(() => buildVerifiedDependencyManifest({ ...f, tarballs: {} }), /Missing tarball/);
  assert.throws(() => buildVerifiedDependencyManifest({
    ...f, tarballs: { ...f.tarballs, 'node_modules/extra': f.bytes }
  }), /Unexpected/);
  assert.throws(() => buildVerifiedDependencyManifest({
    ...f, tarballs: { 'node_modules/is-number': Buffer.from('tampered') }
  }), /integrity mismatch/);
});

test('rejects non-registry URLs, malformed integrity, and unsafe package paths', () => {
  const f = fixture();
  const badUrl = structuredClone(f.lockData);
  badUrl.packages['node_modules/is-number'].resolved = 'https://attacker.invalid/pkg.tgz';
  assert.throws(() => buildVerifiedDependencyManifest({ ...f, lockData: badUrl }), /approved npm registry/);

  const badIntegrity = structuredClone(f.lockData);
  badIntegrity.packages['node_modules/is-number'].integrity = 'sha512-not-valid!';
  assert.throws(() => buildVerifiedDependencyManifest({ ...f, lockData: badIntegrity }), /Unsupported integrity/);

  const badPath = structuredClone(f.lockData);
  badPath.packages['node_modules/../escape'] = badPath.packages['node_modules/is-number'];
  delete badPath.packages['node_modules/is-number'];
  assert.throws(() => buildVerifiedDependencyManifest({ ...f, lockData: badPath,
    tarballs: { 'node_modules/../escape': f.bytes } }), /Unsafe package-lock path/);
});

test('enforces per-package, total-byte, and package-count limits', () => {
  const f = fixture();
  assert.throws(() => buildVerifiedDependencyManifest({
    ...f, limits: { maxPackageBytes: 2 }
  }), /size is invalid/);
  assert.throws(() => buildVerifiedDependencyManifest({
    ...f, limits: { maxTotalBytes: 2 }
  }), /total dependency artifact size/i);
  assert.throws(() => buildVerifiedDependencyManifest({
    ...f, limits: { maxPackages: 0 }
  }), /Invalid artifact limit/);
});
