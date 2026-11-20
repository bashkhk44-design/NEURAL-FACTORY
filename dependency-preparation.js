'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateDependencyPreflight } = require('./dependency-preflight');

const LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);
const DEPENDENCY_GROUPS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'
];

function validatePackageManifest(packageData) {
  const errors = [];
  if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) {
    return { passed: false, errors: ['package.json must contain an object.'] };
  }
  if (packageData.scripts !== undefined &&
      (!packageData.scripts || typeof packageData.scripts !== 'object' ||
       Array.isArray(packageData.scripts))) {
    errors.push('package.json scripts must be an object.');
  } else {
    for (const name of LIFECYCLE_SCRIPTS) {
      if (Object.prototype.hasOwnProperty.call(packageData.scripts || {}, name)) {
        errors.push('Project lifecycle script is not allowed: ' + name);
      }
    }
  }
  const forbiddenPrefixes = ['git+', 'git:', 'https:', 'http:', 'file:', 'link:', 'workspace:', 'github:', 'gitlab:', 'bitbucket:', 'ssh:'];
  for (const group of DEPENDENCY_GROUPS) {
    const entries = packageData[group] || {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      errors.push('Invalid dependency map: ' + group);
      continue;
    }
    for (const [name, spec] of Object.entries(entries)) {
      const nameParts = name.split('/');
      const validName = nameParts.length === 1
        ? /^[a-z0-9._-]+$/i.test(nameParts[0])
        : nameParts.length === 2 && nameParts[0].startsWith('@') &&
          /^[a-z0-9._-]+$/i.test(nameParts[0].slice(1)) && /^[a-z0-9._-]+$/i.test(nameParts[1]);
      if (!validName) errors.push('Invalid npm dependency name: ' + name);
      const normalizedSpec = typeof spec === 'string' ? spec.trim() : '';
      if (!normalizedSpec ||
          forbiddenPrefixes.some(prefix => normalizedSpec.toLowerCase().startsWith(prefix)) ||
          normalizedSpec.includes('/')) {
        errors.push('Only npm registry version, range, or tag specifications are allowed: ' + name);
      }
    }
  }
  return { passed: errors.length === 0, errors };
}

function validateEgressProxy(proxyValue, policyValue) {
  if (policyValue !== 'registry.npmjs.org-only') {
    throw new Error('Dependency preparation requires an explicitly configured npm-registry-only egress policy.');
  }
  if (typeof proxyValue !== 'string' || !proxyValue.trim()) {
    throw new Error('BOSS_NPM_EGRESS_PROXY must point to the trusted policy-enforcing egress proxy.');
  }
  let proxy;
  try { proxy = new URL(proxyValue); } catch {
    throw new Error('BOSS_NPM_EGRESS_PROXY must be a valid proxy URL.');
  }
  if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname ||
      proxy.username || proxy.password || proxy.search || proxy.hash ||
      (proxy.pathname && proxy.pathname !== '/')) {
    throw new Error('The egress proxy URL must not contain credentials, path, query, or fragment.');
  }
  return proxy.toString();
}

function buildNpmArgs({ projectDir, proxy }) {
  return [
    'install', '--package-lock-only', '--ignore-scripts',
    '--package-lock=true', '--lockfile-version=3',
    '--registry=https://registry.npmjs.org/',
    '--https-proxy=' + proxy, '--proxy=' + proxy,
    '--strict-ssl=true', '--fetch-retries=0',
    '--no-audit', '--no-fund',
    '--userconfig=' + path.join(projectDir, '.npmrc-empty'),
    '--globalconfig=' + path.join(projectDir, '.npmrc-empty')
  ];
}

function prepareDependencyLock({
  projectDir,
  outputFile,
  env = process.env,
  spawn = spawnSync
}) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) ||
      !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error('projectDir must be an existing absolute directory.');
  }
  if (typeof outputFile !== 'string' || !path.isAbsolute(outputFile)) {
    throw new Error('outputFile must be an absolute path.');
  }

  const proxy = validateEgressProxy(
    env.BOSS_NPM_EGRESS_PROXY,
    env.BOSS_NPM_EGRESS_POLICY
  );
  const packagePath = path.join(projectDir, 'package.json');
  if (path.resolve(outputFile) === path.resolve(packagePath)) {
    throw new Error('outputFile must not overwrite the input package.json.');
  }
  const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const manifestCheck = validatePackageManifest(packageData);
  if (!manifestCheck.passed) {
    throw new Error('Dependency manifest rejected: ' + manifestCheck.errors.join('; '));
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-dependency-prep-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'package.json'),
      JSON.stringify(packageData, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(tempDir, '.npmrc-empty'), '', { mode: 0o600 });

    const cleanEnv = {
      PATH: env.PATH || '',
      HOME: tempDir,
      TMPDIR: tempDir,
      CI: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_https_proxy: proxy,
      npm_config_proxy: proxy,
      npm_config_strict_ssl: 'true',
      NO_PROXY: '',
      no_proxy: ''
    };
    const args = buildNpmArgs({ projectDir: tempDir, outputFile, proxy });
    const result = spawn('npm', args, {
      cwd: tempDir, env: cleanEnv, encoding: 'utf8',
      timeout: 120000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
      throw new Error('npm lockfile resolution failed: ' +
        String(result.stderr || result.error?.message || 'npm exited unsuccessfully').slice(-4000));
    }

    const generatedPath = path.join(tempDir, 'package-lock.json');
    if (!fs.existsSync(generatedPath)) {
      throw new Error('npm completed without producing package-lock.json.');
    }
    const lockData = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
    const lockCheck = validateDependencyPreflight({ packageData, lockData });
    if (!lockCheck.passed) {
      throw new Error('Generated lockfile rejected: ' + lockCheck.errors.join('; '));
    }

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    const stagedOutput = outputFile + '.tmp-' + process.pid;
    fs.writeFileSync(stagedOutput, JSON.stringify(lockData, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(stagedOutput, outputFile);
    return {
      passed: true,
      outputFile,
      lockfileVersion: lockData.lockfileVersion,
      packageCount: Object.keys(lockData.packages || {}).length - 1
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  validatePackageManifest,
  validateEgressProxy,
  buildNpmArgs,
  prepareDependencyLock
};
