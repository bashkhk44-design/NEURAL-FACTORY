'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 120000;

function validateSandboxImage(image) {
  if (typeof image !== 'string' || !/^[A-Za-z0-9._/:+-]+@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('BOSS_SANDBOX_IMAGE must be an immutable image reference pinned by sha256 digest.');
  }
  return image;
}

function hasProjectTests(files) {
  return files.some(file =>
    /(?:^|\/)(?:test|tests)\/.*\.(?:test|spec)\.[cm]?js$/.test(file.path) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?js$/.test(file.path)
  );
}

function validateRuntimeNodeModules(runtimeNodeModulesDir) {
  if (runtimeNodeModulesDir === undefined || runtimeNodeModulesDir === null) return null;
  if (typeof runtimeNodeModulesDir !== 'string' || !path.isAbsolute(runtimeNodeModulesDir) ||
      !fs.existsSync(runtimeNodeModulesDir)) {
    throw new Error('Runtime node_modules must be an existing absolute directory.');
  }
  const stat = fs.lstatSync(runtimeNodeModulesDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Runtime node_modules must be a real directory, not a symlink.');
  }
  const resolved = fs.realpathSync(runtimeNodeModulesDir);
  if (resolved.includes(',') || resolved.includes(':')) {
    throw new Error('Runtime node_modules path contains unsupported mount characters.');
  }
  return resolved;
}

function ensureRuntimeMountPoint(projectDir) {
  const mountPoint = path.join(projectDir, 'node_modules');
  let stat;
  try {
    stat = fs.lstatSync(mountPoint);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(mountPoint, { mode: 0o755 });
    stat = fs.lstatSync(mountPoint);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Project node_modules mount point must be a real directory.');
  }
  if (fs.readdirSync(mountPoint).length > 0) {
    throw new Error('Project bundle must not contain files in node_modules; verified dependencies use this mount point.');
  }
  fs.chmodSync(mountPoint, 0o755);
  return mountPoint;
}

function parseTapSummary(output) {
  const read = name => {
    const match = String(output || '').match(new RegExp('^# ' + name + ' (\\d+)$', 'm'));
    return match ? Number(match[1]) : 0;
  };
  const tests = read('tests');
  const passed = read('pass');
  const failed = read('fail');
  const cancelled = read('cancelled');
  const skipped = read('skipped');
  const todo = read('todo');
  const valid = tests > 0 &&
    passed + failed + cancelled + skipped + todo === tests;
  return {
    tests, passed, failed, cancelled, skipped, todo,
    valid,
    allPassed: valid && passed === tests && failed === 0 &&
      cancelled === 0 && skipped === 0 && todo === 0
  };
}

function verifyAcceptanceTestCases(output, cases) {
  if (!Array.isArray(cases)) throw new Error('Acceptance test case list must be an array.');
  const lines = String(output || '').split(/\r?\n/);
  const results = [];
  for (const item of cases) {
    if (!item || typeof item.marker !== 'string' ||
        !item.marker.startsWith('[BOSS_ACCEPTANCE:') ||
        typeof item.testName !== 'string' || !item.testName.startsWith(item.marker)) {
      throw new Error('Invalid approved acceptance test marker.');
    }
    const matching = lines.filter(line =>
      /^\s*(?:ok|not ok)\s+\d+\s+-\s/.test(line) &&
      line.includes(item.marker) && line.includes(item.testName)
    );
    const passed = matching.length === 1 &&
      /^\s*ok\s/.test(matching[0]) &&
      !/\s#\s(?:SKIP|TODO)\b/i.test(matching[0]);
    results.push({ acceptanceTestId: item.acceptanceTestId, passed });
  }
  return {
    passed: results.every(item => item.passed),
    results
  };
}

function buildSandboxArgs({ projectDir, image, timeoutMs = DEFAULT_TIMEOUT_MS, runtimeNodeModulesDir }) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) ||
      !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error('Sandbox project directory must be an existing absolute directory.');
  }
  if (projectDir.includes(',') || projectDir.includes(':')) {
    throw new Error('Sandbox project directory contains unsupported mount characters.');
  }
  const pinnedImage = validateSandboxImage(image);
  const runtimeModules = validateRuntimeNodeModules(runtimeNodeModulesDir);
  const timeout = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  return {
    timeout,
    args: [
      'run', '--rm', '--pull=never',
      '--network=none', '--read-only',
      '--memory=256m', '--cpus=0.5', '--pids-limit=64',
      '--user=65532:65532', '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '--mount', 'type=bind,src=' + projectDir + ',dst=/workspace,readonly',
      ...(runtimeModules ? ['--mount', 'type=bind,src=' + runtimeModules + ',dst=/workspace/node_modules,readonly'] : []),
      '--workdir', '/workspace',
      pinnedImage, 'node', '--test', '--test-reporter=tap'
    ]
  };
}

function runSandboxTests({
  projectDir, files, image = process.env.BOSS_SANDBOX_IMAGE,
  timeoutMs = DEFAULT_TIMEOUT_MS, runtimeNodeModulesDir,
  requiredAcceptanceTests = [], spawn = spawnSync
}) {
  if (!hasProjectTests(files || [])) {
    return {
      status: 'skipped', executionStatus: 'not_started',
      repairable: false, passed: null,
      reason: 'No project test files were supplied.'
    };
  }
  const built = buildSandboxArgs({ projectDir, image, timeoutMs, runtimeNodeModulesDir });
  if (runtimeNodeModulesDir) ensureRuntimeMountPoint(projectDir);
  const result = spawn('docker', built.args, {
    encoding: 'utf8',
    timeout: built.timeout,
    windowsHide: true,
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      DOCKER_CONFIG: process.env.DOCKER_CONFIG || ''
    },
    maxBuffer: 1024 * 1024
  });
  const output = String(result.stdout || '') + String(result.stderr || '');
  const summary = parseTapSummary(output);
  if (!summary.valid) {
    return {
      status: 'failed',
      executionStatus: 'not_confirmed',
      repairable: false,
      failureKind: result.error ? 'sandbox_execution_error' : 'missing_or_invalid_test_report',
      passed: false,
      details: output.slice(-6000) ||
        String(result.error?.message || 'Sandbox did not produce a valid TAP execution summary.')
    };
  }

  let acceptance;
  try {
    acceptance = verifyAcceptanceTestCases(output, requiredAcceptanceTests);
  } catch (error) {
    return {
      status: 'failed',
      executionStatus: 'completed',
      repairable: true,
      failureKind: 'acceptance_contract_invalid',
      passed: false,
      testSummary: summary,
      details: String(error.message || error).slice(0, 2000)
    };
  }

  const testsPassed = summary.allPassed && result.status === 0;
  const passed = testsPassed && acceptance.passed;
  const failureKind = passed ? null
    : summary.failed > 0 || summary.skipped > 0 || summary.todo > 0 || summary.cancelled > 0
      ? 'test_cases_failed_or_not_run'
      : !acceptance.passed
        ? 'acceptance_coverage_failed'
        : 'sandbox_runner_exit';

  return {
    status: passed ? 'passed' : 'failed',
    executionStatus: 'completed',
    repairable: failureKind === 'test_cases_failed_or_not_run' ||
      failureKind === 'acceptance_coverage_failed',
    failureKind,
    passed,
    details: passed
      ? (output.slice(-6000) || 'Node test suite completed in isolated container.')
      : 'The isolated test process completed but did not satisfy the test gate. ' +
        JSON.stringify({ summary, acceptance: acceptance.results, exitCode: result.status }) +
        '\n' + output.slice(-5000),
    testSummary: summary,
    acceptanceTests: acceptance.results
  };
}

module.exports = {
  validateSandboxImage, validateRuntimeNodeModules, ensureRuntimeMountPoint,
  hasProjectTests, parseTapSummary, verifyAcceptanceTestCases,
  buildSandboxArgs, runSandboxTests
};
