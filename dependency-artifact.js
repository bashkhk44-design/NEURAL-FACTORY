'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateDependencyPreflight } = require('./dependency-preflight');

const MAX_PACKAGES = 300;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const HASH_STRENGTH = { sha256: 1, sha384: 2, sha512: 3 };

function parseIntegrity(value) {
  if (typeof value !== 'string') throw new Error('Package integrity is missing.');
  const candidates = value.trim().split(/\s+/).map(token => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    return match ? { algorithm: match[1], digest: match[2] } : null;
  }).filter(Boolean).sort((a, b) => HASH_STRENGTH[b.algorithm] - HASH_STRENGTH[a.algorithm]);
  if (!candidates.length) throw new Error('No supported SRI digest is present.');
  return candidates;
}

function verifyTarballIntegrity(filePath, integrity, maxBytes = MAX_TARBALL_BYTES) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error('Downloaded package archive is empty or exceeds the size limit.');
  }
  const bytes = fs.readFileSync(filePath);
  const candidates = parseIntegrity(integrity);
  const matched = candidates.some(({ algorithm, digest }) => {
    const actual = Buffer.from(crypto.createHash(algorithm).update(bytes).digest('base64'));
    const expected = Buffer.from(digest);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
  if (!matched) throw new Error('Downloaded package archive failed its SRI integrity check.');
  return {
    size: stat.size,
    sha512: crypto.createHash('sha512').update(bytes).digest('hex')
  };
}

function validateRegistryTarballUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new Error('Invalid package tarball URL.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' ||
      url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Package tarball URL is outside the approved npm registry.');
  }
  return url.toString();
}

function buildPackArgs({ tarballUrl, destination, proxy }) {
  return [
    'pack', tarballUrl, '--ignore-scripts', '--json',
    '--pack-destination=' + destination,
    '--registry=https://registry.npmjs.org/',
    '--https-proxy=' + proxy, '--proxy=' + proxy,
    '--strict-ssl=true', '--fetch-retries=0',
    '--no-audit', '--no-fund',
    '--userconfig=' + path.join(destination, '.npmrc-empty'),
    '--globalconfig=' + path.join(destination, '.npmrc-empty')
  ];
}

function prepareOfflineDependencyArtifact({
  projectDir,
  outputDir,
  env = process.env,
  spawn = spawnSync
}) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) ||
      !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error('projectDir must be an existing absolute directory.');
  }
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) ||
      path.resolve(outputDir) === path.parse(outputDir).root) {
    throw new Error('outputDir must be a safe absolute directory path.');
  }
  const resolvedProject = fs.realpathSync(projectDir);
  const resolvedOutputParent = path.resolve(path.dirname(outputDir));
  if (resolvedOutputParent === resolvedProject ||
      resolvedOutputParent.startsWith(resolvedProject + path.sep) ||
      resolvedProject.startsWith(path.resolve(outputDir) + path.sep)) {
    throw new Error('Offline artifact output must be outside the customer project directory.');
  }
  if (fs.existsSync(outputDir)) throw new Error('outputDir already exists; refusing to overwrite an artifact.');
  if (!fs.existsSync(resolvedOutputParent) || !fs.statSync(resolvedOutputParent).isDirectory()) {
    throw new Error('The output parent directory must already exist.');
  }

  if (env.BOSS_NPM_EGRESS_POLICY !== 'registry.npmjs.org-only') {
    throw new Error('Dependency artifact preparation requires the registry-only egress policy.');
  }
  let proxy;
  try { proxy = new URL(env.BOSS_NPM_EGRESS_PROXY); } catch {
    throw new Error('A trusted BOSS_NPM_EGRESS_PROXY is required.');
  }
  if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname ||
      proxy.username || proxy.password || proxy.search || proxy.hash ||
      (proxy.pathname && proxy.pathname !== '/')) {
    throw new Error('The egress proxy URL must not contain credentials, path, query, or fragment.');
  }
  proxy = proxy.toString();

  const packageData = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  const lockData = JSON.parse(fs.readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'));
  const preflight = validateDependencyPreflight({ packageData, lockData });
  if (!preflight.passed) throw new Error('Dependency preflight rejected the project: ' + preflight.errors.join('; '));

  const entries = Object.entries(lockData.packages).filter(([key]) => key !== '');
  if (!entries.length || entries.length > MAX_PACKAGES) {
    throw new Error('Dependency package count is empty or exceeds the preparation limit.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-offline-deps-'));
  const stagedDir = outputDir + '.staging-' + process.pid;
  if (fs.existsSync(stagedDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error('A staging path already exists; refusing to overwrite it.');
  }
  let totalBytes = 0;
  try {
    fs.mkdirSync(path.join(tempDir, 'downloads'));
    fs.writeFileSync(path.join(tempDir, '.npmrc-empty'), '', { mode: 0o600 });
    fs.writeFileSync(path.join(tempDir, 'downloads', '.npmrc-empty'), '', { mode: 0o600 });
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
    const artifacts = [];
    for (let index = 0; index < entries.length; index++) {
      const [lockPath, entry] = entries[index];
      const tarballUrl = validateRegistryTarballUrl(entry.resolved);
      parseIntegrity(entry.integrity);
      const destination = path.join(tempDir, 'downloads');
      const result = spawn('npm', buildPackArgs({ tarballUrl, destination, proxy }), {
        cwd: tempDir, env: cleanEnv, encoding: 'utf8',
        timeout: 120000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
      });
      if (result.error || result.status !== 0) {
        throw new Error('npm package download failed for ' + lockPath + ': ' +
          String(result.stderr || result.error?.message || 'npm exited unsuccessfully').slice(-2000));
      }
      let packed;
      try { packed = JSON.parse(result.stdout); } catch {
        throw new Error('npm pack returned invalid JSON for ' + lockPath + '.');
      }
      const filename = Array.isArray(packed) && packed[0] && packed[0].filename;
      if (typeof filename !== 'string' || path.basename(filename) !== filename || !filename.endsWith('.tgz')) {
        throw new Error('npm pack returned an unsafe archive filename for ' + lockPath + '.');
      }
      const downloaded = path.join(destination, filename);
      const verified = verifyTarballIntegrity(downloaded, entry.integrity);
      totalBytes += verified.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Total dependency archive size exceeds the preparation limit.');
      artifacts.push({ lockPath, version: entry.version || null, file: String(index).padStart(4, '0') + '.tgz', downloadedFilename: filename, ...verified });
    }

    fs.mkdirSync(stagedDir, { mode: 0o700 });
    const artifactFiles = path.join(stagedDir, 'packages');
    fs.mkdirSync(artifactFiles, { mode: 0o700 });
    artifacts.forEach((artifact, index) => {
      const source = path.join(tempDir, 'downloads', artifact.downloadedFilename);
      const destination = path.join(artifactFiles, artifact.file);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      const copied = verifyTarballIntegrity(destination, entries[index][1].integrity);
      if (copied.sha512 !== artifact.sha512) throw new Error('Copied archive digest changed during artifact assembly.');
      fs.chmodSync(destination, 0o444);
    });
    const manifest = {
      format: 'boss-offline-dependencies-v1',
      createdAt: new Date().toISOString(),
      lockfileSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(projectDir, 'package-lock.json'))).digest('hex'),
      packageCount: artifacts.length,
      totalBytes,
      packages: artifacts.map(({ downloadedFilename, ...artifact }) => artifact)
    };
    fs.writeFileSync(path.join(stagedDir, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o444, flag: 'wx' });
    fs.chmodSync(artifactFiles, 0o555);
    fs.chmodSync(stagedDir, 0o555);
    fs.renameSync(stagedDir, outputDir);
    return {
      passed: true,
      outputDir,
      packageCount: artifacts.length,
      totalBytes,
      manifestSha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    };
  } finally {
    try {
      if (fs.existsSync(stagedDir)) {
        const packageDirectory = path.join(stagedDir, 'packages');
        if (fs.existsSync(packageDirectory)) fs.chmodSync(packageDirectory, 0o755);
        fs.chmodSync(stagedDir, 0o755);
        fs.rmSync(stagedDir, { recursive: true, force: true });
      }
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  parseIntegrity,
  verifyTarballIntegrity,
  validateRegistryTarballUrl,
  buildPackArgs,
  prepareOfflineDependencyArtifact
};
