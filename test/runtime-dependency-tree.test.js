'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  computeDirectoryTreeDigest,
  prepareRuntimeDependencyTree
} = require('../runtime-dependency-tree');

function fixture(t, packages = [{ name: 'demo', version: '1.0.0', bin: { 'demo-cli': './bin/cli.js' } }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-runtime-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, 'verified-runtime');
  const nodeModulesDir = path.join(outputDir, 'node_modules');
  fs.mkdirSync(nodeModulesDir, { recursive: true, mode: 0o755 });
  const lockPackages = { '': { name: 'fixture', version: '1.0.0' } };
  for (const pkg of packages) {
    const packageDir = path.join(nodeModulesDir, pkg.name);
    fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: pkg.name, version: pkg.version, type: pkg.type, bin: pkg.bin
    }));
    fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = { value: "dependency-ok" };\n');
    if (pkg.bin) {
      const binTarget = pkg.binTarget || 'bin/cli.js';
      const targetPath = path.join(packageDir, binTarget);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath,
        "process.stdout.write('bin-ok:' + process.argv.slice(2).join(','));\n");
    }
    lockPackages['node_modules/' + pkg.name] = { version: pkg.version };
  }
  const lockfilePath = path.join(root, 'package-lock.json');
  fs.writeFileSync(lockfilePath, JSON.stringify({
    name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: lockPackages
  }));
  return { root, outputDir, nodeModulesDir, lockfilePath };
}

test('creates executable wrappers and runs package bins without symlinks', t => {
  const item = fixture(t);
  const result = prepareRuntimeDependencyTree(item);
  const wrapper = path.join(item.nodeModulesDir, '.bin', 'demo-cli');
  assert.deepEqual(result.binWrappers, ['.bin/demo-cli']);
  assert.equal((fs.statSync(wrapper).mode & 0o111) !== 0, true);
  assert.equal(fs.lstatSync(wrapper).isSymbolicLink(), false);
  assert.equal(execFileSync(wrapper, ['one', 'two'], { encoding: 'utf8' }), 'bin-ok:one,two');
  assert.match(result.treeSha256, /^[a-f0-9]{64}$/);
  assert.equal(computeDirectoryTreeDigest(item.nodeModulesDir).sha256, result.treeSha256);
});

test('supports ESM package executable entry points', t => {
  const item = fixture(t, [{
    name: 'demo', version: '1.0.0', type: 'module',
    bin: { 'demo-cli': './bin/cli.mjs' }, binTarget: 'bin/cli.mjs'
  }]);
  prepareRuntimeDependencyTree(item);
  const wrapper = path.join(item.nodeModulesDir, '.bin', 'demo-cli');
  assert.equal(execFileSync(wrapper, ['esm'], { encoding: 'utf8' }), 'bin-ok:esm');
});

test('rejects non-JavaScript executable targets', t => {
  const item = fixture(t, [{
    name: 'demo', version: '1.0.0',
    bin: { 'demo-cli': './bin/cli.sh' }, binTarget: 'bin/cli.sh'
  }]);
  assert.throws(() => prepareRuntimeDependencyTree(item), /Only JavaScript package executable targets/);
});

test('produces the same tree digest for identical dependency contents', t => {
  const first = fixture(t);
  const second = fixture(t);
  const firstResult = prepareRuntimeDependencyTree(first);
  const secondResult = prepareRuntimeDependencyTree(second);
  assert.equal(firstResult.treeSha256, secondResult.treeSha256);
  assert.equal(firstResult.fileCount, secondResult.fileCount);
  assert.equal(firstResult.directoryCount, secondResult.directoryCount);
});

test('canonical permissions keep identical dependency trees reproducible across umasks', t => {
  const first = fixture(t);
  const second = fixture(t);
  fs.chmodSync(first.nodeModulesDir, 0o700);
  fs.chmodSync(path.join(first.nodeModulesDir, 'demo'), 0o700);
  fs.chmodSync(path.join(first.nodeModulesDir, 'demo', 'bin'), 0o700);
  fs.chmodSync(path.join(first.nodeModulesDir, 'demo', 'package.json'), 0o600);
  fs.chmodSync(path.join(first.nodeModulesDir, 'demo', 'index.js'), 0o600);
  fs.chmodSync(path.join(first.nodeModulesDir, 'demo', 'bin', 'cli.js'), 0o600);
  const firstResult = prepareRuntimeDependencyTree(first);
  const secondResult = prepareRuntimeDependencyTree(second);
  assert.equal(firstResult.treeSha256, secondResult.treeSha256);
  assert.equal(fs.statSync(first.nodeModulesDir).mode & 0o777, 0o755);
});

test('tree digest changes when a dependency file changes', t => {
  const item = fixture(t, [{ name: 'demo', version: '1.0.0' }]);
  const before = computeDirectoryTreeDigest(item.nodeModulesDir).sha256;
  fs.appendFileSync(path.join(item.nodeModulesDir, 'demo', 'index.js'), '// changed\n');
  const after = computeDirectoryTreeDigest(item.nodeModulesDir).sha256;
  assert.notEqual(before, after);
});

test('rejects package executable path traversal', t => {
  const item = fixture(t, [{ name: 'demo', version: '1.0.0', bin: { 'demo-cli': '../../outside.js' } }]);
  assert.throws(() => prepareRuntimeDependencyTree(item), /executable target path is unsafe/);
});

test('rejects symlink executable targets', t => {
  const item = fixture(t);
  const packageDir = path.join(item.nodeModulesDir, 'demo');
  fs.rmSync(path.join(packageDir, 'bin', 'cli.js'));
  fs.symlinkSync(path.join(packageDir, 'index.js'), path.join(packageDir, 'bin', 'cli.js'));
  assert.throws(() => prepareRuntimeDependencyTree(item), /symbolic link|regular non-linked file/);
});

test('rejects duplicate executable names within the same bin directory', t => {
  const item = fixture(t, [
    { name: 'demo', version: '1.0.0', bin: { 'shared-cli': './bin/cli.js' } },
    { name: 'other', version: '1.0.0', bin: { 'shared-cli': './bin/cli.js' } }
  ]);
  assert.throws(() => prepareRuntimeDependencyTree(item), /same executable/);
});

test('rejects linked files anywhere in the runtime dependency tree', t => {
  const item = fixture(t, [{ name: 'demo', version: '1.0.0' }]);
  try {
    fs.linkSync(path.join(item.nodeModulesDir, 'demo', 'index.js'),
      path.join(item.nodeModulesDir, 'demo', 'copy.js'));
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
      t.skip(`Hard links are unavailable in this environment: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => computeDirectoryTreeDigest(item.nodeModulesDir), /hard-linked file/);
});
