'use strict';

const crypto = require('node:crypto');

const DEFAULT_LIMITS = Object.freeze({
  maxPackages: 500,
  maxPackageBytes: 50 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024
});

function validateRegistryUrl(value, packagePath) {
  let url;
  try { url = new URL(value); } catch {
    throw new Error('Invalid registry URL for ' + packagePath);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' ||
      url.username || url.password || url.port || url.hash) {
    throw new Error('Package URL is outside the approved npm registry: ' + packagePath);
  }
  return url.toString();
}

function parseIntegrity(value, packagePath) {
  if (typeof value !== 'string') throw new Error('Missing integrity for ' + packagePath);
  const tokens = value.trim().split(/\s+/).map(token => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match) throw new Error('Unsupported integrity token for ' + packagePath);
    const digest = Buffer.from(match[2], 'base64');
    const expectedBytes = { sha256: 32, sha384: 48, sha512: 64 }[match[1]];
    if (digest.length !== expectedBytes || digest.toString('base64') !== match[2]) {
      throw new Error('Malformed integrity digest for ' + packagePath);
    }
    return { algorithm: match[1], digest: match[2] };
  });
  const rank = { sha256: 1, sha384: 2, sha512: 3 };
  const strongest = Math.max(...tokens.map(token => rank[token.algorithm]));
  return tokens.filter(token => rank[token.algorithm] === strongest);
}

function validatePackagePath(value) {
  if (typeof value !== 'string' || !value.startsWith('node_modules/')) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !part.includes('\\'));
}

function buildVerifiedDependencyManifest({ lockData, tarballs, limits = {} }) {
  if (!lockData || typeof lockData !== 'object' || ![2, 3].includes(lockData.lockfileVersion) ||
      !lockData.packages || typeof lockData.packages !== 'object' || Array.isArray(lockData.packages)) {
    throw new Error('A valid npm package-lock v2 or v3 is required.');
  }
  if (!tarballs || (typeof tarballs !== 'object' && !(tarballs instanceof Map))) {
    throw new Error('Tarballs must be supplied as a Map or object keyed by package-lock path.');
  }

  const cap = { ...DEFAULT_LIMITS, ...limits };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(cap[key]) || cap[key] < 1) {
      throw new Error('Invalid artifact limit: ' + key);
    }
  }

  const packageEntries = Object.entries(lockData.packages).filter(([name]) => name !== '');
  if (packageEntries.length > cap.maxPackages) throw new Error('Dependency package count exceeds the configured limit.');

  const getTarball = name => tarballs instanceof Map ? tarballs.get(name) : tarballs[name];
  const suppliedNames = tarballs instanceof Map ? [...tarballs.keys()] : Object.keys(tarballs);
  const expectedNames = new Set(packageEntries.map(([name]) => name));
  for (const name of suppliedNames) {
    if (!expectedNames.has(name)) throw new Error('Unexpected dependency tarball: ' + name);
  }

  let totalBytes = 0;
  const packages = [];
  for (const [packagePath, entry] of packageEntries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!validatePackagePath(packagePath)) throw new Error('Unsafe package-lock path: ' + packagePath);
    if (!entry || typeof entry !== 'object' || entry.link === true) {
      throw new Error('Invalid or linked dependency entry: ' + packagePath);
    }
    const resolved = validateRegistryUrl(entry.resolved, packagePath);
    const allowedIntegrity = parseIntegrity(entry.integrity, packagePath);
    const bytes = getTarball(packagePath);
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
      throw new Error('Missing tarball bytes for ' + packagePath);
    }
    const data = Buffer.from(bytes);
    if (!data.length || data.length > cap.maxPackageBytes) {
      throw new Error('Dependency tarball size is invalid: ' + packagePath);
    }
    totalBytes += data.length;
    if (totalBytes > cap.maxTotalBytes) throw new Error('Total dependency artifact size exceeds the configured limit.');

    const matched = allowedIntegrity.some(item =>
      crypto.createHash(item.algorithm).update(data).digest('base64') === item.digest
    );
    if (!matched) throw new Error('Dependency tarball integrity mismatch: ' + packagePath);

    packages.push({
      packagePath,
      version: typeof entry.version === 'string' ? entry.version : null,
      resolved,
      integrity: entry.integrity,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      sizeBytes: data.length
    });
  }

  return {
    format: 'boss-dependency-artifact-manifest',
    formatVersion: 1,
    lockfileVersion: lockData.lockfileVersion,
    packageCount: packages.length,
    totalBytes,
    packages
  };
}

module.exports = { buildVerifiedDependencyManifest, DEFAULT_LIMITS };
