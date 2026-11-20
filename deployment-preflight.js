'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { validateBundle } = require('./ai-builder');
const { validateManifest, scanForEmbeddedSecrets } = require('./ai-tester');
const { validateSandboxImage, validateRuntimeNodeModules } = require('./project-sandbox');
const { evaluateDeploymentReadiness } = require('./deployment-readiness');

const PREFLIGHT_PORT = 41739;
const PREFLIGHT_TIMEOUT_MS = 30000;
const MAX_PREFLIGHT_TIMEOUT_MS = 45000;

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeDeploymentAuthorizationDigest({ release, authorizedBy }) {
  return sha256(stableJson({
    releaseId: String(release.id),
    projectId: String(release.project_id),
    releaseVersion: Number(release.release_version),
    specVersion: Number(release.spec_version),
    artifactSha256: release.artifact_sha256,
    authorizedBy: String(authorizedBy)
  }));
}

function computeExecutionApprovalDigest({
  releaseId, artifactSha256, provider, serviceId, environment, approvedBy
}) {
  return sha256(stableJson({
    releaseId: String(releaseId),
    artifactSha256,
    provider,
    serviceId,
    environment,
    approvedBy: String(approvedBy)
  }));
}

function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

function supportsNodeEngine(range, runtimeVersion) {
  if (typeof range !== 'string' || !range.trim()) return false;
  const actual = parseNodeVersion(runtimeVersion);
  if (!actual) return false;

  const alternatives = range.split('||').map(value => value.trim());
  if (alternatives.length > 8) return false;

  return alternatives.some(alternative => {
    const tokens = alternative.split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > 12) return false;

    return tokens.every(token => {
      const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(token);
      if (!match) return false;
      const operator = match[1] || '';
      const major = Number(match[2]);
      const minorToken = match[3];
      const patchToken = match[4];

      if (minorToken === undefined || minorToken === 'x' || minorToken === '*') {
        if (operator === '>=' || operator === '>' || operator === '<=' || operator === '<') {
          const floor = { major, minor: 0, patch: 0 };
          const comparison = compareVersions(actual, floor);
          if (operator === '>=') return comparison >= 0;
          if (operator === '>') return comparison > 0;
          if (operator === '<=') return comparison <= 0;
          return comparison < 0;
        }
        if (operator === '^' || operator === '~') return actual.major === major;
        if (operator === '<' || operator === '>') return false;
        return actual.major === major;
      }

      const minor = Number(minorToken);
      if (patchToken === undefined || patchToken === 'x' || patchToken === '*') {
        if (operator === '^' || operator === '~' || !operator || operator === '=') {
          return actual.major === major && actual.minor === minor;
        }
        const floor = { major, minor, patch: 0 };
        const comparison = compareVersions(actual, floor);
        if (operator === '>=') return comparison >= 0;
        if (operator === '>') return comparison > 0;
        if (operator === '<=') return comparison <= 0;
        if (operator === '<') return comparison < 0;
        return false;
      }

      const patch = Number(patchToken);
      const floor = { major, minor, patch };
      const comparison = compareVersions(actual, floor);
      if (operator === '>=') return comparison >= 0;
      if (operator === '>') return comparison > 0;
      if (operator === '<=') return comparison <= 0;
      if (operator === '<') return comparison < 0;
      if (operator === '^') return actual.major === major && comparison >= 0;
      if (operator === '~') return actual.major === major && actual.minor === minor && comparison >= 0;
      return comparison === 0;
    });
  });
}

function buildHealthProbeScript({ startScript, healthCheck, requiredEnv }) {
  const envEntries = requiredEnv.map(name =>
    JSON.stringify(name) + ':' + JSON.stringify('BOSS_PREFLIGHT_PLACEHOLDER')
  ).join(',');
  const appEnv = '{' + envEntries +
    (envEntries ? ',' : '') +
    '"NODE_ENV":"production","PORT":' + JSON.stringify(String(PREFLIGHT_PORT)) +
    ',"HOST":"127.0.0.1"}';

  const lines = [
    "'use strict';",
    "const { spawn } = require('node:child_process');",
    "const { setTimeout: delay } = require('node:timers/promises');",
    "async function main() {",
    "  const runtimeVersion = process.version;",
    "  const healthPath = " + JSON.stringify(healthCheck) + ";",
    "  if (!healthPath) {",
    "    process.stdout.write(JSON.stringify({ runtimeVersion, healthStatus: null }));",
    "    process.exitCode = 2;",
    "    return;",
    "  }",
    "  const child = spawn('npm', ['run', " + JSON.stringify(startScript) + "], {",
    "    cwd: '/workspace',",
    "    env: Object.assign({ PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', npm_config_cache: '/tmp/npm-cache' }, " + appEnv + "),",
    "    stdio: 'ignore'",
    "  });",
    "  let exited = false;",
    "  child.once('exit', () => { exited = true; });",
    "  child.once('error', () => { exited = true; });",
    "  let healthStatus = null;",
    "  for (let attempt = 0; attempt < 40 && !exited; attempt += 1) {",
    "    try {",
    "      const response = await fetch('http://127.0.0.1:" + PREFLIGHT_PORT + "' + healthPath, { signal: AbortSignal.timeout(500) });",
    "      if (response.status >= 200 && response.status < 300) { healthStatus = response.status; break; }",
    "    } catch (_) {}",
    "    await delay(250);",
    "  }",
    "  if (!exited) {",
    "    child.kill('SIGTERM');",
    "    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1000)]);",
    "    if (child.exitCode === null) child.kill('SIGKILL');",
    "  }",
    "  process.stdout.write(JSON.stringify({ runtimeVersion, healthStatus }));",
    "  if (healthStatus === null) process.exitCode = 1;",
    "}",
    "main().catch(() => {",
    "  process.stdout.write(JSON.stringify({ runtimeVersion: process.version, healthStatus: null }));",
    "  process.exitCode = 1;",
    "});"
  ];
  return lines.join('\n');
}

function buildPreflightDockerArgs({ projectDir, image, runtimeNodeModulesDir, script }) {
  if (!path.isAbsolute(projectDir) || !fs.existsSync(projectDir) ||
      !fs.statSync(projectDir).isDirectory()) {
    throw new Error('Preflight project directory must be an existing absolute directory.');
  }
  if (projectDir.includes(',') || projectDir.includes(':')) {
    throw new Error('Preflight project directory contains unsupported mount characters.');
  }

  const pinnedImage = validateSandboxImage(image);
  const runtimeModules = runtimeNodeModulesDir
    ? validateRuntimeNodeModules(runtimeNodeModulesDir)
    : null;
  if (runtimeModules && (runtimeModules.includes(',') || runtimeModules.includes(':'))) {
    throw new Error('Runtime dependency mount path contains unsupported characters.');
  }

  return [
    'run', '--rm', '--pull=never',
    '--network=none', '--read-only',
    '--memory=256m', '--cpus=0.5', '--pids-limit=64',
    '--user=65532:65532', '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
    '--mount', 'type=bind,src=' + projectDir + ',dst=/workspace,readonly',
    ...(runtimeModules
      ? ['--mount', 'type=bind,src=' + runtimeModules + ',dst=/workspace/node_modules,readonly']
      : []),
    '--workdir', '/workspace',
    pinnedImage, 'node', '-e', script
  ];
}

function runHealthProbe({
  files,
  manifest,
  packageData,
  image = process.env.BOSS_SANDBOX_IMAGE,
  runtimeNodeModulesDir,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
  spawn = spawnSync
}) {
  if (!manifest?.healthCheck) {
    return {
      passed: false,
      runtimeVersion: null,
      healthStatus: null,
      evidence: 'A healthCheck route is not declared in boss-manifest.json.'
    };
  }

  const dependencies = packageData.dependencies && Object.keys(packageData.dependencies).length > 0;
  const devDependencies = packageData.devDependencies && Object.keys(packageData.devDependencies).length > 0;
  if ((dependencies || devDependencies) && !runtimeNodeModulesDir) {
    return {
      passed: false,
      runtimeVersion: null,
      healthStatus: null,
      evidence: 'Verified offline runtime dependencies are required but were not supplied.'
    };
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-deployment-preflight-'));
  const projectDir = path.join(root, 'project');
  try {
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o755 });
    for (const file of files) {
      const destination = path.resolve(projectDir, file.path);
      if (!destination.startsWith(projectDir + path.sep)) {
        throw new Error('Unsafe artifact path while staging the preflight workspace.');
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      fs.writeFileSync(destination, file.content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    }
    fs.chmodSync(projectDir, 0o755);

    const script = buildHealthProbeScript({
      startScript: manifest.startScript,
      healthCheck: manifest.healthCheck,
      requiredEnv: manifest.requiredEnv
    });
    const args = buildPreflightDockerArgs({
      projectDir,
      image,
      runtimeNodeModulesDir,
      script
    });
    const timeout = Math.max(1000, Math.min(MAX_PREFLIGHT_TIMEOUT_MS, Number(timeoutMs) || PREFLIGHT_TIMEOUT_MS));
    const result = spawn('docker', args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        DOCKER_CONFIG: process.env.DOCKER_CONFIG || ''
      }
    });
    const output = String(result.stdout || '').trim();
    let report = null;
    for (const line of output.split(/\r?\n/).reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') {
          report = parsed;
          break;
        }
      } catch (_) {}
    }
    const runtimeVersion = parseNodeVersion(report?.runtimeVersion)
      ? report.runtimeVersion
      : null;
    const healthStatus = Number.isInteger(report?.healthStatus) ? report.healthStatus : null;
    const passed = result.status === 0 && runtimeVersion !== null &&
      healthStatus !== null && healthStatus >= 200 && healthStatus < 300;
    return {
      passed,
      runtimeVersion,
      healthStatus,
      evidence: passed
        ? 'The application start command returned a 2xx health response inside the network-disabled Docker sandbox.'
        : 'The isolated startup probe did not produce a successful 2xx health response. ' +
          String(result.error?.message || result.stderr || 'No valid health result was reported.').slice(0, 500)
    };
  } catch (error) {
    return {
      passed: false,
      runtimeVersion: null,
      healthStatus: null,
      evidence: 'The isolated health probe could not be completed: ' +
        String(error.message || error).slice(0, 500)
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function validTarget(target, release) {
  return Boolean(target &&
    typeof target.provider === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(target.provider) &&
    typeof target.serviceId === 'string' &&
    target.serviceId.trim().length > 0 &&
    target.serviceId === target.serviceId.trim() &&
    target.serviceId.length <= 200 &&
    ['staging', 'production'].includes(target.environment) &&
    target.confirmed === true &&
    target.artifactSha256 === release?.artifact_sha256);
}

function validRollbackRelease(rollbackRelease, release) {
  if (!rollbackRelease || !/^\d+$/.test(String(rollbackRelease.id || '')) ||
      String(rollbackRelease.id) === String(release?.id) ||
      String(rollbackRelease.project_id) !== String(release?.project_id) ||
      rollbackRelease.status !== 'approved' ||
      !/^[a-f0-9]{64}$/.test(String(rollbackRelease.artifact_sha256 || '')) ||
      !rollbackRelease.artifact) return false;
  return sha256(stableJson(rollbackRelease.artifact)) === rollbackRelease.artifact_sha256;
}

function runDeploymentPreflight({
  release,
  authorization,
  target,
  executionApproval,
  configuredEnvNames = [],
  rollbackRelease,
  image = process.env.BOSS_SANDBOX_IMAGE,
  runtimeNodeModulesDir,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
  spawn = spawnSync
} = {}) {
  const checks = [];
  const add = (name, passed, evidence) => checks.push({
    name,
    passed: passed === true,
    evidence: String(evidence || '').slice(0, 1000)
  });

  let artifactValid = false;
  let files = [];
  let packageData = null;
  let manifest = null;
  let artifactEvidence = 'Release artifact is missing or has an invalid digest.';

  try {
    if (!release || !release.artifact ||
        sha256(stableJson(release.artifact)) !== release.artifact_sha256) {
      throw new Error('Release artifact SHA-256 does not match its immutable stored payload.');
    }
    const validated = validateBundle(release.artifact.bundle);
    files = validated.files;
    const packageFile = files.find(file => file.path === 'package.json');
    const manifestFile = files.find(file => file.path === 'boss-manifest.json');
    if (!packageFile || !manifestFile) throw new Error('package.json or boss-manifest.json is missing.');
    packageData = JSON.parse(packageFile.content);
    manifest = validateManifest(JSON.parse(manifestFile.content), packageData);
    const secretFindings = scanForEmbeddedSecrets(files);
    if (secretFindings.length) {
      throw new Error('Embedded credentials were detected in the release files.');
    }
    artifactValid = true;
    artifactEvidence = 'Stored artifact digest, bundle paths, package manifest, and embedded-secret scan passed.';
  } catch (error) {
    artifactEvidence = String(error.message || error).slice(0, 900);
  }
  add('artifact_integrity', artifactValid, artifactEvidence);

  const targetValid = validTarget(target, release);
  add('target_configured', targetValid,
    targetValid
      ? 'Explicit provider, service ID, environment, confirmation, and artifact digest match. No provider API was contacted.'
      : 'Target metadata is missing, malformed, unconfirmed, or bound to another artifact.');

  const configured = new Set(Array.isArray(configuredEnvNames)
    ? configuredEnvNames.filter(name => typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(name))
    : []);
  const missingEnv = manifest
    ? manifest.requiredEnv.filter(name => !configured.has(name))
    : [];
  const secretsAvailable = Boolean(manifest) && missingEnv.length === 0;
  add('secrets_available', secretsAvailable,
    secretsAvailable
      ? 'All required environment variable names are configured; no secret values were read or passed to the sandbox.'
      : manifest
        ? 'Missing required environment variable names: ' + missingEnv.join(', ')
        : 'Required environment names could not be verified without a valid manifest.');

  const rollbackValid = validRollbackRelease(rollbackRelease, release);
  add('rollback_plan', rollbackValid,
    rollbackValid
      ? 'A prior approved release for the same project has a verified immutable artifact digest.'
      : 'A prior approved release with a verified artifact digest is required for rollback.');

  const probe = artifactValid && packageData && manifest
    ? runHealthProbe({
        files,
        manifest,
        packageData,
        image,
        runtimeNodeModulesDir,
        timeoutMs,
        spawn
      })
    : {
        passed: false,
        runtimeVersion: null,
        healthStatus: null,
        evidence: 'Health probe was not started because the release artifact failed validation.'
      };

  const engineRange = packageData?.engines?.node;
  const runtimeCompatible = Boolean(probe.runtimeVersion) &&
    typeof engineRange === 'string' &&
    supportsNodeEngine(engineRange, probe.runtimeVersion);
  add('runtime_compatibility', runtimeCompatible,
    runtimeCompatible
      ? 'Pinned sandbox runtime ' + probe.runtimeVersion + ' satisfies the package Node.js engine range.'
      : 'The pinned sandbox runtime could not be verified or does not satisfy package.json engines.node.');

  add('health_check', probe.passed,
    probe.evidence + (probe.healthStatus ? ' HTTP ' + probe.healthStatus + '.' : ''));

  const authorizationDigestValid = Boolean(authorization && release &&
    authorization.authorization_sha256 === computeDeploymentAuthorizationDigest({
      release,
      authorizedBy: authorization.authorized_by
    }));
  const executionApprovalDigestValid = Boolean(executionApproval &&
    executionApproval.approvalSha256 === computeExecutionApprovalDigest(executionApproval));

  const readiness = evaluateDeploymentReadiness({
    release,
    authorization: authorizationDigestValid
      ? authorization
      : { ...authorization, status: 'invalid' },
    target,
    executionApproval: executionApprovalDigestValid
      ? executionApproval
      : { ...executionApproval, status: 'invalid' },
    checks
  });

  return {
    checks,
    missingEnv,
    runtimeVersion: probe.runtimeVersion,
    healthStatus: probe.healthStatus,
    readiness,
    executionAllowed: false,
    deployed: false
  };
}

module.exports = {
  stableJson,
  sha256,
  computeDeploymentAuthorizationDigest,
  computeExecutionApprovalDigest,
  parseNodeVersion,
  supportsNodeEngine,
  buildHealthProbeScript,
  buildPreflightDockerArgs,
  runHealthProbe,
  validTarget,
  validRollbackRelease,
  runDeploymentPreflight
};
