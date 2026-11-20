'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSandboxTests } = require('../project-sandbox');
const { prepareRuntimeDependencyTree } = require('../runtime-dependency-tree');

test('loads a verified dependency and executes its generated bin wrapper inside the network-disabled Docker sandbox', {
  skip: !process.env.BOSS_SANDBOX_IMAGE
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-dependency-integration-'));
  const projectDir = path.join(root, 'project');
  const outputDir = path.join(root, 'verified-runtime');
  const nodeModulesDir = path.join(outputDir, 'node_modules');
  const packageDir = path.join(nodeModulesDir, 'demo');
  const lockfilePath = path.join(root, 'package-lock.json');
  try {
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      bin: { 'demo-cli': './bin/cli.js' }
    }));
    fs.writeFileSync(path.join(packageDir, 'index.js'),
      "module.exports = { value: 'dependency-ok' };\n");
    fs.writeFileSync(path.join(packageDir, 'bin', 'cli.js'),
      "process.stdout.write('bin-ok:' + process.argv.slice(2).join(','));\n");
    fs.writeFileSync(lockfilePath, JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/demo': { version: '1.0.0' }
      }
    }));
    fs.writeFileSync(path.join(projectDir, 'smoke.test.js'), [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const path = require('node:path');",
      "const { execFileSync } = require('node:child_process');",
      "test('verified package resolves from node_modules', () => {",
      "  assert.deepEqual(require('demo'), { value: 'dependency-ok' });",
      "});",
      "test('generated executable wrapper runs without a symlink', () => {",
      "  const wrapper = path.join(__dirname, 'node_modules', '.bin', 'demo-cli');",
      "  assert.equal(execFileSync(wrapper, ['from-container'], { encoding: 'utf8' }), 'bin-ok:from-container');",
      "});"
    ].join('\n'));
    const runtime = prepareRuntimeDependencyTree({ outputDir, lockfilePath });
    fs.chmodSync(projectDir, 0o755);
    const result = runSandboxTests({
      projectDir,
      files: [{ path: 'smoke.test.js' }],
      image: process.env.BOSS_SANDBOX_IMAGE,
      timeoutMs: 30000,
      runtimeNodeModulesDir: runtime.nodeModulesDir
    });
    assert.equal(result.status, 'passed', result.details || result.reason);
    assert.equal(result.passed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
