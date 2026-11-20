'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { unpackVerifiedDependencies } = require('../offline-dependency-unpack');

function tarHeader(name, size, type = '0', linkname = '') {
  const header = Buffer.alloc(512);
  function put(value, start, length) {
    Buffer.from(String(value)).copy(header, start, 0, length);
  }
  function octal(value, start, length) {
    put(value.toString(8).padStart(length - 1, '0') + '\0', start, length);
  }
  put(name, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

function makeTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content || '');
    chunks.push(tarHeader(entry.name, data.length, entry.type || '0', entry.linkname || ''));
    if (data.length) chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function setup(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-unpack-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, 'artifact');
  const packagesDir = path.join(artifactDir, 'packages');
  fs.mkdirSync(packagesDir, { recursive: true });
  const lockfilePath = path.join(root, 'package-lock.json');
  const packageJson = JSON.stringify({ name: 'demo', version: '1.2.3' });
  const archive = makeTar(entries || [
    { name: 'package/', type: '5' },
    { name: 'package/package.json', content: packageJson },
    { name: 'package/index.js', content: 'module.exports = 1;\n' }
  ]);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64');
  const lockData = {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/demo': {
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/demo/-/demo-1.2.3.tgz',
        integrity
      }
    }
  };
  const lockBytes = Buffer.from(JSON.stringify(lockData));
  fs.writeFileSync(lockfilePath, lockBytes);
  fs.writeFileSync(path.join(packagesDir, '0000.tgz'), archive);
  const manifest = {
    format: 'boss-offline-dependencies-v1',
    createdAt: new Date(0).toISOString(),
    lockfileSha256: crypto.createHash('sha256').update(lockBytes).digest('hex'),
    packageCount: 1,
    totalBytes: archive.length,
    packages: [{
      lockPath: 'node_modules/demo',
      version: '1.2.3',
      file: '0000.tgz',
      size: archive.length,
      sha512: crypto.createHash('sha512').update(archive).digest('hex')
    }]
  };
  fs.writeFileSync(path.join(artifactDir, 'artifact-manifest.json'), JSON.stringify(manifest));
  return { root, artifactDir, lockfilePath, outputDir: path.join(root, 'runtime'), archive, manifest, lockData };
}

test('unpacks verified package archives into deterministic node_modules paths', t => {
  const fixture = setup(t);
  const result = unpackVerifiedDependencies(fixture);
  assert.equal(result.passed, true);
  assert.equal(result.networkUsed, false);
  assert.equal(result.packageCount, 1);
  assert.equal(fs.readFileSync(path.join(result.outputDir, 'node_modules/demo/index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.outputDir, 'node_modules/demo/package.json'))).version, '1.2.3');
});

test('rejects archive path traversal and removes partial output', t => {
  const fixture = setup(t, [
    { name: 'package/', type: '5' },
    { name: 'package/package.json', content: JSON.stringify({ name: 'demo', version: '1.2.3' }) },
    { name: 'package/../../escape.txt', content: 'bad' }
  ]);
  assert.throws(() => unpackVerifiedDependencies(fixture), /Unsafe path/);
  assert.equal(fs.existsSync(fixture.outputDir), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'escape.txt')), false);
});

test('rejects symbolic links and hard links in tar archives', t => {
  const fixture = setup(t, [
    { name: 'package/', type: '5' },
    { name: 'package/package.json', content: JSON.stringify({ name: 'demo', version: '1.2.3' }) },
    { name: 'package/link', type: '2', linkname: '../../outside' }
  ]);
  assert.throws(() => unpackVerifiedDependencies(fixture), /symbolic-link/);
  assert.equal(fs.existsSync(fixture.outputDir), false);
});

test('rejects package identity that differs from the lockfile', t => {
  const fixture = setup(t, [
    { name: 'package/', type: '5' },
    { name: 'package/package.json', content: JSON.stringify({ name: 'impostor', version: '1.2.3' }) }
  ]);
  assert.throws(() => unpackVerifiedDependencies(fixture), /name\/version does not match/);
});

test('rejects archive tampering even when manifest size is unchanged', t => {
  const fixture = setup(t);
  const archivePath = path.join(fixture.artifactDir, 'packages/0000.tgz');
  const bytes = fs.readFileSync(archivePath);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(archivePath, bytes);
  assert.throws(() => unpackVerifiedDependencies(fixture), /SHA-512 mismatch|SRI mismatch/);
});

test('rejects a lockfile changed after artifact preparation', t => {
  const fixture = setup(t);
  fs.appendFileSync(fixture.lockfilePath, ' ');
  assert.throws(() => unpackVerifiedDependencies(fixture), /different package-lock/);
});

test('refuses to overwrite an existing output directory', t => {
  const fixture = setup(t);
  fs.mkdirSync(fixture.outputDir);
  assert.throws(() => unpackVerifiedDependencies(fixture), /already exists/);
});

test('enforces expanded package limits', t => {
  const fixture = setup(t, [
    { name: 'package/', type: '5' },
    { name: 'package/package.json', content: JSON.stringify({ name: 'demo', version: '1.2.3' }) },
    { name: 'package/large.txt', content: '1234567890' }
  ]);
  assert.throws(() => unpackVerifiedDependencies({ ...fixture, limits: { maxExpandedBytes: 8 } }), /expansion limits|expanded size/);
  assert.equal(fs.existsSync(fixture.outputDir), false);
});
