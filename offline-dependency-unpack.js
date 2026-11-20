'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const DEFAULT_LIMITS = Object.freeze({
  maxPackages: 300,
  maxArchiveBytes: 100 * 1024 * 1024,
  maxTotalArchiveBytes: 1024 * 1024 * 1024,
  maxManifestBytes: 5 * 1024 * 1024,
  maxLockfileBytes: 50 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxTotalExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxFiles: 50000,
  maxPathBytes: 1024
});

function fail(message) { throw new Error(message); }

function safeRelativePath(value, maxPathBytes) {
  if (typeof value !== 'string' || !value || value.includes('\0') ||
      value.startsWith('/') || value.includes('\\') ||
      Buffer.byteLength(value) > maxPathBytes) return false;
  const parts = value.replace(/\/+$/, '').split('/');
  return parts.length > 0 && parts.every(part =>
    part && part !== '.' && part !== '..' && !part.includes(':')
  );
}

function parseOctal(buffer, start, length, label) {
  const raw = buffer.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) fail('Invalid tar ' + label + ' field.');
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail('Unsafe tar ' + label + ' value.');
  return value;
}

function decodeTarString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8');
}

function verifyTarHeader(header) {
  const expected = parseOctal(header, 148, 8, 'checksum');
  let actual = 0;
  for (let i = 0; i < 512; i++) actual += (i >= 148 && i < 156) ? 32 : header[i];
  if (actual !== expected) fail('Tar header checksum mismatch.');
}

function parsePax(data) {
  const values = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) fail('Malformed PAX record length.');
    const lengthText = data.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) fail('Malformed PAX record length.');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > data.length) {
      fail('PAX record exceeds its metadata block.');
    }
    const record = data.subarray(space + 1, offset + length);
    if (record[record.length - 1] !== 0x0a) fail('Malformed PAX record terminator.');
    const line = record.subarray(0, -1).toString('utf8');
    const equals = line.indexOf('=');
    if (equals <= 0) fail('Malformed PAX key/value record.');
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (!['path'].includes(key)) fail('Unsupported PAX metadata field: ' + key);
    values[key] = value;
    offset += length;
  }
  return values;
}

function parseSRI(value) {
  if (typeof value !== 'string') fail('Lockfile integrity is missing.');
  const ranks = { sha256: 1, sha384: 2, sha512: 3 };
  const tokens = value.trim().split(/\s+/).map(token => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match) return null;
    const expected = { sha256: 32, sha384: 48, sha512: 64 }[match[1]];
    const digest = Buffer.from(match[2], 'base64');
    if (digest.length !== expected || digest.toString('base64') !== match[2]) return null;
    return { algorithm: match[1], digest: match[2], rank: ranks[match[1]] };
  }).filter(Boolean);
  if (!tokens.length) fail('Lockfile integrity has no valid supported digest.');
  const strongest = Math.max(...tokens.map(item => item.rank));
  return tokens.filter(item => item.rank === strongest);
}

function verifyArchive(archivePath, artifact, lockEntry, limits) {
  const stat = fs.lstatSync(archivePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 ||
      stat.size > limits.maxArchiveBytes || stat.size !== artifact.size) {
    fail('Dependency archive is missing, unsafe, or has an invalid size: ' + artifact.lockPath);
  }
  const bytes = fs.readFileSync(archivePath);
  const sha512 = crypto.createHash('sha512').update(bytes).digest('hex');
  if (sha512 !== artifact.sha512) fail('Artifact SHA-512 mismatch: ' + artifact.lockPath);
  const sri = parseSRI(lockEntry.integrity);
  const sriMatches = sri.some(item =>
    crypto.createHash(item.algorithm).update(bytes).digest('base64') === item.digest
  );
  if (!sriMatches) fail('Lockfile SRI mismatch: ' + artifact.lockPath);
  return bytes;
}

function derivePackageName(lockPath) {
  const marker = '/node_modules/';
  const nested = lockPath.lastIndexOf(marker);
  let relative = nested >= 0 ? lockPath.slice(nested + marker.length) : lockPath.slice('node_modules/'.length);
  if (relative.startsWith('@')) {
    const parts = relative.split('/');
    if (parts.length !== 2) fail('Invalid scoped package path: ' + lockPath);
    return relative;
  }
  if (relative.includes('/')) fail('Invalid package-lock path nesting: ' + lockPath);
  return relative;
}

function parseTarArchive(gzipBytes, destination, limits, budget) {
  let tarBytes;
  try {
    tarBytes = zlib.gunzipSync(gzipBytes, { maxOutputLength: limits.maxExpandedBytes });
  } catch (error) {
    fail('Dependency archive gzip stream is invalid or exceeds expansion limits: ' + error.message);
  }
  let offset = 0;
  let pendingPax = {};
  let pendingLongName = null;
  const seen = new Set();
  let fileCount = 0;
  let expandedBytes = 0;
  let packageJson = null;
  let zeroBlocks = 0;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(byte => byte === 0)) {
      zeroBlocks++;
      if (zeroBlocks >= 2) break;
      continue;
    }
    if (zeroBlocks) fail('Tar data appears after an end-of-archive marker.');
    verifyTarHeader(header);

    const headerName = decodeTarString(header.subarray(0, 100));
    const prefix = decodeTarString(header.subarray(345, 500));
    let entryName = pendingLongName || (prefix ? prefix + '/' + headerName : headerName);
    pendingLongName = null;
    if (Object.hasOwn(pendingPax, 'path')) entryName = pendingPax.path;
    const localPax = pendingPax;
    pendingPax = {};

    const size = parseOctal(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156] || 48);
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tarBytes.length) fail('Tar entry exceeds archive bounds.');
    const body = tarBytes.subarray(offset, offset + size);
    offset += paddedSize;

    if (type === 'x') {
      if (size > 64 * 1024) fail('PAX metadata block is too large.');
      pendingPax = parsePax(body);
      continue;
    }
    if (type === 'L') {
      if (size > limits.maxPathBytes + 1) fail('GNU long path exceeds limit.');
      pendingLongName = decodeTarString(body);
      continue;
    }
    if (type === 'g' || type === 'K' || type === 'S' || type === '1' || type === '2') {
      fail('Global PAX, sparse, hard-link, or symbolic-link tar entries are not allowed.');
    }
    if (!['0', '\0', '5'].includes(type)) fail('Unsupported tar entry type: ' + type);
    if (typeof entryName !== 'string' || !entryName.startsWith('package/')) {
      fail('Archive entry is outside the package/ root.');
    }
    let relative = entryName.slice('package/'.length).replace(/\/+$/, '');
    if (!relative) {
      if (type !== '5') fail('Package root entry must be a directory.');
      continue;
    }
    if (!safeRelativePath(relative, limits.maxPathBytes)) fail('Unsafe path in dependency archive: ' + relative);
    const parts = relative.split('/');
    const target = path.resolve(destination, ...parts);
    if (target !== destination && !target.startsWith(destination + path.sep)) fail('Tar entry escaped package destination.');
    const normalized = parts.join('/');
    if (seen.has(normalized)) fail('Duplicate path in dependency archive: ' + normalized);
    seen.add(normalized);
    fileCount++;
    budget.files++;
    if (budget.files > limits.maxFiles) fail('Dependency artifacts contain too many total entries.');

    if (type === '5') {
      if (size !== 0) fail('Tar directory entry contains data.');
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      continue;
    }

    if (size > limits.maxExpandedBytes || expandedBytes + size > limits.maxExpandedBytes) {
      fail('Dependency archive expanded size exceeds the per-package limit.');
    }
    expandedBytes += size;
    budget.total += size;
    if (budget.total > limits.maxTotalExpandedBytes) fail('Total expanded dependency size exceeds the configured limit.');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const fd = fs.openSync(target, 'wx', 0o644);
    try { fs.writeFileSync(fd, body); } finally { fs.closeSync(fd); }
    if (normalized === 'package.json') {
      if (packageJson) fail('Dependency archive contains duplicate package/package.json.');
      try { packageJson = JSON.parse(body.toString('utf8')); } catch { fail('Package package.json is invalid JSON.'); }
    }
  }

  if (zeroBlocks < 2 || offset < 1024) fail('Tar archive is missing its end-of-archive blocks.');
  return { packageJson, expandedBytes, fileCount };
}

function unpackVerifiedDependencies({ artifactDir, lockfilePath, outputDir, limits = {} }) {
  for (const [name, value] of Object.entries({ artifactDir, lockfilePath, outputDir })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(name + ' must be an absolute path.');
  }
  const cap = { ...DEFAULT_LIMITS, ...limits };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(cap[key]) || cap[key] < 1) fail('Invalid unpack limit: ' + key);
  }
  const artifactLstat = fs.lstatSync(artifactDir);
  const lockLstat = fs.lstatSync(lockfilePath);
  if (artifactLstat.isSymbolicLink() || !artifactLstat.isDirectory() ||
      lockLstat.isSymbolicLink() || !lockLstat.isFile()) fail('Artifact directory and lockfile must be real directory/file paths.');
  const artifactRoot = fs.realpathSync(artifactDir);
  const lockReal = fs.realpathSync(lockfilePath);
  if (path.resolve(outputDir) === path.parse(path.resolve(outputDir)).root) fail('Output directory cannot be a filesystem root.');
  const outputParent = path.resolve(path.dirname(path.resolve(outputDir)));
  if (!fs.existsSync(outputParent) || !fs.statSync(outputParent).isDirectory()) fail('Output parent directory must already exist.');
  const outputRealParent = fs.realpathSync(outputParent);
  const requestedOutput = path.resolve(outputDir);
  if (path.basename(requestedOutput) === '.' || path.basename(requestedOutput) === '..') fail('Output directory path is invalid.');
  const finalOutput = path.join(outputRealParent, path.basename(requestedOutput));
  if (fs.existsSync(finalOutput)) fail('Output directory already exists; refusing to overwrite.');
  if (finalOutput === artifactRoot || finalOutput.startsWith(artifactRoot + path.sep) ||
      artifactRoot.startsWith(finalOutput + path.sep)) fail('Output directory must not overlap the artifact directory.');
  if (finalOutput === path.dirname(lockReal) || lockReal.startsWith(finalOutput + path.sep)) {
    fail('Output directory must not overlap the lockfile.');
  }

  const packagesRoot = path.join(artifactRoot, 'packages');
  const packagesRootStat = fs.lstatSync(packagesRoot);
  if (packagesRootStat.isSymbolicLink() || !packagesRootStat.isDirectory()) fail('Artifact packages path must be a real directory.');
  const manifestPath = path.join(artifactRoot, 'artifact-manifest.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > cap.maxManifestBytes) fail('Artifact manifest must be a bounded regular file.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || manifest.format !== 'boss-offline-dependencies-v1' ||
      !Array.isArray(manifest.packages) || manifest.packageCount !== manifest.packages.length ||
      manifest.packages.length > cap.maxPackages) fail('Unsupported or invalid offline dependency manifest.');

  const lockStat = fs.statSync(lockReal);
  if (lockStat.size > cap.maxLockfileBytes) fail('package-lock.json exceeds the configured size limit.');
  const lockBytes = fs.readFileSync(lockReal);
  const lockSha = crypto.createHash('sha256').update(lockBytes).digest('hex');
  if (lockSha !== manifest.lockfileSha256) fail('Artifact was prepared for a different package-lock.json.');
  const lockData = JSON.parse(lockBytes.toString('utf8'));
  if (!lockData.packages || typeof lockData.packages !== 'object' || Array.isArray(lockData.packages)) {
    fail('package-lock.json packages map is invalid.');
  }
  const expectedEntries = Object.entries(lockData.packages).filter(([key]) => key !== '').sort(([a], [b]) => a.localeCompare(b));
  if (expectedEntries.length !== manifest.packages.length) fail('Manifest package count does not match package-lock.json.');

  const artifactByPath = new Map();
  const artifactFiles = new Set();
  let manifestBytes = 0;

  for (const item of manifest.packages) {
    if (!item || typeof item.lockPath !== 'string' || artifactByPath.has(item.lockPath) ||
        typeof item.file !== 'string' || !/^[0-9]{4}\.tgz$/.test(item.file) ||
        !Number.isSafeInteger(item.size) || item.size < 1 ||
        typeof item.sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(item.sha512) ||
      artifactFiles.has(item.file)) {
      fail('Malformed package entry in offline dependency manifest.');
    }
    artifactFiles.add(item.file);
    manifestBytes += item.size;
    artifactByPath.set(item.lockPath, item);
  }
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes !== manifestBytes || manifestBytes > cap.maxTotalArchiveBytes) {
    fail('Manifest total archive size does not match its package entries.');
  }
  for (const [lockPath, entry] of expectedEntries) {
    const item = artifactByPath.get(lockPath);
    if (!item || item.version !== (entry.version || null)) fail('Manifest does not match lockfile entry: ' + lockPath);
  }

  fs.mkdirSync(finalOutput, { mode: 0o700 });
  let totalExpanded = 0;
  let extractedPackages = 0;
  const unpackBudget = { total: 0, files: 0 };
  try {
    const nodeModules = path.join(finalOutput, 'node_modules');
    fs.mkdirSync(nodeModules, { mode: 0o755 });
    for (const [lockPath, lockEntry] of expectedEntries) {
      if (!lockPath.startsWith('node_modules/') || !safeRelativePath(lockPath, cap.maxPathBytes)) {
        fail('Unsafe package-lock path: ' + lockPath);
      }
      const item = artifactByPath.get(lockPath);
      const archivePath = path.join(artifactRoot, 'packages', item.file);
      const archiveBytes = verifyArchive(archivePath, item, lockEntry, cap);
      const packageDestination = path.resolve(finalOutput, lockPath);
      if (!packageDestination.startsWith(nodeModules + path.sep)) fail('Package destination escaped node_modules.');
      fs.mkdirSync(path.dirname(packageDestination), { recursive: true, mode: 0o755 });
      fs.mkdirSync(packageDestination, { mode: 0o755 });
      const parsed = parseTarArchive(archiveBytes, packageDestination, cap, unpackBudget);
      totalExpanded = unpackBudget.total;
      if (!parsed.packageJson || typeof parsed.packageJson !== 'object' ||
          parsed.packageJson.name !== derivePackageName(lockPath) ||
          parsed.packageJson.version !== lockEntry.version) {
        fail('Unpacked package name/version does not match lockfile: ' + lockPath);
      }
      extractedPackages++;
    }
    return {
      passed: true,
      outputDir: finalOutput,
      packageCount: extractedPackages,
      expandedBytes: totalExpanded,
      networkUsed: false
    };
  } catch (error) {
    fs.rmSync(finalOutput, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  DEFAULT_LIMITS,
  safeRelativePath,
  parsePax,
  parseTarArchive,
  unpackVerifiedDependencies
};
