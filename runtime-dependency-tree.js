'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function fail(message) {
  throw new Error(message);
}

function isInside(parent, candidate) {
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

function safePackageRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') ||
      value.startsWith('/') || value.includes('\\') || path.posix.isAbsolute(value)) {
    return false;
  }
  const normalized = value.replace(/^\.\//, '');
  const parts = normalized.split('/');
  return normalized.length > 0 && parts.every(part =>
    part && part !== '.' && part !== '..' && !part.includes(':')
  );
}

function packageBinEntries(packageJson) {
  if (packageJson.bin === undefined) return [];
  if (typeof packageJson.bin === 'string') {
    const packageName = typeof packageJson.name === 'string' ? packageJson.name : '';
    const command = packageName.split('/').pop();
    return [[command, packageJson.bin]];
  }
  if (!packageJson.bin || typeof packageJson.bin !== 'object' || Array.isArray(packageJson.bin)) {
    fail('Package bin metadata must be a string or command map.');
  }
  return Object.entries(packageJson.bin);
}

function expectedPackageName(lockPath) {
  const marker = '/node_modules/';
  const nested = lockPath.lastIndexOf(marker);
  const relative = nested >= 0
    ? lockPath.slice(nested + marker.length)
    : lockPath.slice('node_modules/'.length);
  const parts = relative.split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function nearestNodeModulesDir(packageDir, nodeModulesRoot) {
  let current = path.dirname(packageDir);
  while (isInside(nodeModulesRoot, current)) {
    if (path.basename(current) === 'node_modules') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail('Could not resolve the package node_modules directory.');
}

function createBinWrapper({ binDir, command, target }) {
  if (typeof command !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(command) ||
      command === '.' || command === '..') {
    fail('Package contains an unsafe executable name.');
  }
  const wrapper = path.join(binDir, command);
  const relativeTarget = path.relative(binDir, target).split(path.sep).join('/');
  if (!relativeTarget || path.isAbsolute(relativeTarget) ||
      path.resolve(binDir, relativeTarget) !== target) {
    fail('Package executable target could not be represented safely.');
  }
  const source = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const path = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    'const target = path.resolve(__dirname, ' + JSON.stringify(relativeTarget) + ');',
    'process.argv[1] = target;',
    "if (path.extname(target) === '') require(target);",
    "else import(pathToFileURL(target).href).catch(error => { console.error(error); process.exitCode = 1; });",
    ''
  ].join('\n');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const fd = fs.openSync(wrapper, 'wx', 0o755);
  try {
    fs.writeFileSync(fd, source, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(wrapper, 0o755);
}

function createPackageBinWrappers({ nodeModulesDir, lockData }) {
  const entries = Object.entries(lockData.packages || {}).filter(([key]) => key !== '');
  const created = [];
  const seen = new Set();

  for (const [lockPath, lockEntry] of entries) {
    if (typeof lockPath !== 'string' || !lockPath.startsWith('node_modules/') ||
        !safePackageRelativePath(lockPath)) {
      fail('Unsafe package-lock path while preparing executable wrappers.');
    }
    const packageRelative = lockPath.slice('node_modules/'.length);
    const packageDir = path.resolve(nodeModulesDir, packageRelative);
    if (!isInside(nodeModulesDir, packageDir) || packageDir === nodeModulesDir) {
      fail('Package directory escaped node_modules.');
    }
    const packageStat = fs.lstatSync(packageDir);
    if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) {
      fail('Package directory is missing or is not a real directory: ' + lockPath);
    }
    const packageJsonPath = path.join(packageDir, 'package.json');
    const packageJsonStat = fs.lstatSync(packageJsonPath);
    if (packageJsonStat.isSymbolicLink() || !packageJsonStat.isFile()) {
      fail('Package metadata is missing or unsafe: ' + lockPath);
    }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (!lockEntry || packageJson.name !== expectedPackageName(lockPath) ||
        packageJson.version !== lockEntry.version) {
      fail('Package identity does not match package-lock while preparing executable wrappers: ' + lockPath);
    }
    const binEntries = packageBinEntries(packageJson);
    if (!binEntries.length) continue;

    const binDir = path.join(nearestNodeModulesDir(packageDir, nodeModulesDir), '.bin');
    if (fs.existsSync(binDir)) {
      const binDirStat = fs.lstatSync(binDir);
      if (binDirStat.isSymbolicLink() || !binDirStat.isDirectory()) {
        fail('Package executable directory is not a real directory.');
      }
    } else {
      fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
    }
    for (const [command, relativeTargetValue] of binEntries) {
      if (!safePackageRelativePath(relativeTargetValue)) {
        fail('Package executable target path is unsafe: ' + lockPath);
      }
      const relativeTarget = relativeTargetValue.replace(/^\.\//, '');
      const target = path.resolve(packageDir, relativeTarget);
      if (!isInside(packageDir, target) || target === packageDir) {
        fail('Package executable target escaped its package directory.');
      }
      const targetExtension = path.extname(target).toLowerCase();
      if (!['', '.js', '.cjs', '.mjs'].includes(targetExtension)) {
        fail('Only JavaScript package executable targets are supported: ' + lockPath);
      }
      const targetStat = fs.lstatSync(target);
      if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink !== 1) {
        fail('Package executable target must be a regular non-linked file: ' + lockPath);
      }
      const identity = binDir + '\0' + command;
      if (seen.has(identity)) fail('Multiple packages declare the same executable: ' + command);
      seen.add(identity);
      createBinWrapper({ binDir, command, target });
      created.push(path.relative(nodeModulesDir, path.join(binDir, command)).split(path.sep).join('/'));
    }
  }
  return created.sort();
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function normalizeRuntimeTreePermissions(rootDir, executableWrappers) {
  const executableSet = new Set(executableWrappers || []);

  function visit(directory, relativeDirectory) {
    const names = fs.readdirSync(directory);
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory ? relativeDirectory + '/' + name : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('Runtime dependency tree contains a symbolic link: ' + relative);
      if (stat.isDirectory()) {
        visit(absolute, relative);
        fs.chmodSync(absolute, 0o755);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) fail('Runtime dependency tree contains a hard-linked file: ' + relative);
        fs.chmodSync(absolute, executableSet.has(relative) ? 0o755 : 0o644);
      } else {
        fail('Runtime dependency tree contains an unsupported filesystem entry: ' + relative);
      }
    }
  }

  visit(rootDir, '');
  fs.chmodSync(rootDir, 0o755);
}

function computeDirectoryTreeDigest(rootDir) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
    fail('Runtime dependency directory must be an absolute path.');
  }
  const rootStat = fs.lstatSync(rootDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail('Runtime dependency directory must be a real directory.');
  }
  const root = fs.realpathSync(rootDir);
  const records = [];

  function visit(directory, relativeDirectory) {
    const names = fs.readdirSync(directory).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) {
      if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
        fail('Runtime dependency tree contains an invalid filename.');
      }
      const absolute = path.join(directory, name);
      const relative = relativeDirectory ? relativeDirectory + '/' + name : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('Runtime dependency tree contains a symbolic link: ' + relative);
      if (stat.isDirectory()) {
        records.push([relative, 'directory', stat.mode & 0o777, 0, '']);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) fail('Runtime dependency tree contains a hard-linked file: ' + relative);
        const digest = hashFile(absolute);
        records.push([relative, 'file', stat.mode & 0o777, stat.size, digest]);
      } else {
        fail('Runtime dependency tree contains an unsupported filesystem entry: ' + relative);
      }
    }
  }

  visit(root, '');
  records.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const hash = crypto.createHash('sha256');
  for (const record of records) {
    hash.update(JSON.stringify(record));
    hash.update('\n');
  }
  return {
    sha256: hash.digest('hex'),
    fileCount: records.filter(record => record[1] === 'file').length,
    directoryCount: records.filter(record => record[1] === 'directory').length
  };
}

function prepareRuntimeDependencyTree({ outputDir, lockfilePath }) {
  for (const [name, value] of Object.entries({ outputDir, lockfilePath })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(name + ' must be an absolute path.');
  }
  const outputStat = fs.lstatSync(outputDir);
  const lockStat = fs.lstatSync(lockfilePath);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory() ||
      lockStat.isSymbolicLink() || !lockStat.isFile()) {
    fail('Runtime output and package-lock must be real directory/file paths.');
  }
  const output = fs.realpathSync(outputDir);
  const nodeModulesDir = path.join(output, 'node_modules');
  const nodeModulesStat = fs.lstatSync(nodeModulesDir);
  if (nodeModulesStat.isSymbolicLink() || !nodeModulesStat.isDirectory()) {
    fail('Verified runtime node_modules directory is missing or unsafe.');
  }
  const lockData = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  if (!lockData.packages || typeof lockData.packages !== 'object' || Array.isArray(lockData.packages)) {
    fail('package-lock.json packages map is invalid.');
  }
  computeDirectoryTreeDigest(nodeModulesDir);
  const binWrappers = createPackageBinWrappers({ nodeModulesDir, lockData });
  normalizeRuntimeTreePermissions(nodeModulesDir, binWrappers);
  const tree = computeDirectoryTreeDigest(nodeModulesDir);
  const lockfileSha256 = crypto.createHash('sha256').update(fs.readFileSync(lockfilePath)).digest('hex');
  return {
    nodeModulesDir,
    lockfileSha256,
    treeSha256: tree.sha256,
    fileCount: tree.fileCount,
    directoryCount: tree.directoryCount,
    binWrappers
  };
}

module.exports = {
  safePackageRelativePath,
  packageBinEntries,
  expectedPackageName,
  createPackageBinWrappers,
  normalizeRuntimeTreePermissions,
  computeDirectoryTreeDigest,
  prepareRuntimeDependencyTree
};
