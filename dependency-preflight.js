'use strict';

const ALLOWED_REGISTRY_HOSTS = new Set(['registry.npmjs.org']);
const LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);
const DEPENDENCY_GROUPS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'
];
const NON_REGISTRY_SPEC = /^(?:git\+|git:|https?:|file:|link:|workspace:|github:|gitlab:|bitbucket:|ssh:)/i;

function validateDependencyPreflight({ packageData, lockData }) {
  const errors = [];
  if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) {
    return { passed: false, errors: ['package.json must contain an object.'] };
  }
  if (!lockData || typeof lockData !== 'object' || Array.isArray(lockData)) {
    return { passed: false, errors: ['package-lock.json must contain an object.'] };
  }
  if (![2, 3].includes(lockData.lockfileVersion) || !lockData.packages ||
      typeof lockData.packages !== 'object' || Array.isArray(lockData.packages)) {
    errors.push('A package-lock v2 or v3 with a packages map is required.');
  }

  const scripts = packageData.scripts || {};
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    errors.push('package.json scripts must be an object.');
  } else {
    for (const name of LIFECYCLE_SCRIPTS) {
      if (Object.prototype.hasOwnProperty.call(scripts, name)) {
        errors.push('Project lifecycle script is not allowed: ' + name);
      }
    }
  }

  const declared = [];
  for (const group of DEPENDENCY_GROUPS) {
    const entries = packageData[group] || {};
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      errors.push('Invalid dependency map: ' + group);
      continue;
    }
    for (const [name, spec] of Object.entries(entries)) {
      declared.push(name);
      if (typeof spec !== 'string' || !spec.trim() || NON_REGISTRY_SPEC.test(spec.trim())) {
        errors.push('Non-registry dependency spec is not allowed: ' + name);
      }
    }
  }

  const packages = lockData.packages && typeof lockData.packages === 'object'
    ? lockData.packages : {};
  for (const name of declared) {
    const lockPath = 'node_modules/' + name;
    if (!Object.prototype.hasOwnProperty.call(packages, lockPath)) {
      errors.push('Declared dependency is missing from package-lock: ' + name);
    }
  }

  for (const [packagePath, entry] of Object.entries(packages)) {
    if (!packagePath) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.link === true) {
      errors.push('Invalid or linked lockfile package: ' + packagePath);
      continue;
    }
    if (typeof entry.resolved !== 'string') {
      errors.push('Missing resolved registry URL: ' + packagePath);
      continue;
    }
    let url;
    try { url = new URL(entry.resolved); } catch {
      errors.push('Invalid package URL: ' + packagePath);
      continue;
    }
    if (url.protocol !== 'https:' || !ALLOWED_REGISTRY_HOSTS.has(url.hostname) ||
        url.username || url.password || url.port) {
      errors.push('Package URL is outside the approved HTTPS npm registry: ' + packagePath);
    }
    if (typeof entry.integrity !== 'string' ||
        !/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/.test(entry.integrity)) {
      errors.push('Missing supported integrity hash: ' + packagePath);
    }
  }

  return { passed: errors.length === 0, errors };
}

module.exports = { validateDependencyPreflight };
