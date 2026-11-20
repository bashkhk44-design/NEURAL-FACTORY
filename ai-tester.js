'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateBundle } = require('./ai-builder');
const { runSandboxTests } = require('./project-sandbox');
const { validateDependencyPreflight } = require('./dependency-preflight');
const { unpackVerifiedDependencies } = require('./offline-dependency-unpack');
const { prepareRuntimeDependencyTree } = require('./runtime-dependency-tree');
const { validateDesignMap } = require('./build-design-map');

function validateManifest(manifest, packageData) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('boss-manifest.json يجب أن يحتوي كائناً صالحاً.');
  }

  const allowedKeys = new Set(['version', 'requiredEnv', 'optionalEnv', 'startScript', 'healthCheck']);
  for (const key of Object.keys(manifest)) {
    if (!allowedKeys.has(key)) throw new Error('حقل غير مسموح في manifest: ' + key);
  }
  if (manifest.version !== 1) throw new Error('إصدار manifest غير مدعوم؛ المطلوب version: 1.');

  for (const field of ['requiredEnv', 'optionalEnv']) {
    if (!Array.isArray(manifest[field])) throw new Error(field + ' يجب أن تكون قائمة أسماء متغيرات.');
    if (manifest[field].length > 100) throw new Error('عدد متغيرات البيئة كبير جداً.');
    for (const name of manifest[field]) {
      if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(name)) {
        throw new Error('اسم متغير بيئة غير صالح في ' + field + '.');
      }
    }
    if (new Set(manifest[field]).size !== manifest[field].length) {
      throw new Error('يوجد اسم متغير مكرر في ' + field + '.');
    }
  }

  const overlap = manifest.requiredEnv.filter(name => manifest.optionalEnv.includes(name));
  if (overlap.length) throw new Error('متغير موجود في requiredEnv وoptionalEnv معاً: ' + overlap[0]);
  if (typeof manifest.startScript !== 'string' || !/^[a-zA-Z0-9:_-]{1,60}$/.test(manifest.startScript)) {
    throw new Error('startScript يجب أن يكون اسم أمر صالحاً من package.json.');
  }
  if (!packageData.scripts || typeof packageData.scripts[manifest.startScript] !== 'string' ||
      !packageData.scripts[manifest.startScript].trim()) {
    throw new Error('أمر startScript غير موجود في package.json scripts.');
  }
  if (manifest.healthCheck !== undefined &&
      (typeof manifest.healthCheck !== 'string' || !/^\/[a-zA-Z0-9/_-]*$/.test(manifest.healthCheck) ||
       manifest.healthCheck.includes('..'))) {
    throw new Error('healthCheck يجب أن يكون مساراً داخلياً صالحاً.');
  }
  return {
    version: 1,
    requiredEnv: [...manifest.requiredEnv],
    optionalEnv: [...manifest.optionalEnv],
    startScript: manifest.startScript,
    healthCheck: manifest.healthCheck || null
  };
}

function scanForEmbeddedSecrets(files) {
  const patterns = [
    { name: 'PEM_PRIVATE_KEY', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
    { name: 'GOOGLE_API_KEY', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
    { name: 'TELEGRAM_BOT_TOKEN', regex: /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/ },
    { name: 'AWS_ACCESS_KEY', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'GITHUB_TOKEN', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
    { name: 'SLACK_TOKEN', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
    { name: 'STRIPE_SECRET_KEY', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
    { name: 'OPENAI_API_KEY', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/ }
  ];
  const findings = [];
  for (const file of files) {
    const content = String(file.content || '');
    for (const pattern of patterns) {
      if (pattern.regex.test(content)) findings.push({ path: file.path, type: pattern.name });
    }
  }
  return findings;
}

async function testProjectBundle({ bundle, dependencyArtifactDir, designArtifact }) {
  const checks = [];
  const add = (name, passed, details = '') => checks.push({ name, passed, details });
  let validated;

  try {
    validated = validateBundle(bundle);
    add('bundle-validation', true);
  } catch (error) {
    add('bundle-validation', false, error.message);
    return { passed: false, checks, summary: 'فشل التحقق من حزمة المشروع.' };
  }

  const secretFindings = scanForEmbeddedSecrets(validated.files);
  add('embedded-secrets', secretFindings.length === 0,
    secretFindings.map(item => item.path + ' [' + item.type + ']').join('; '));
  if (secretFindings.length > 0) {
    return {
      passed: false, checks, manifest: null,
      summary: 'تم إيقاف الاختبار بسبب وجود بيانات اعتماد مضمّنة داخل ملفات المشروع.'
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-bot-test-'));
  let runtimeTempDir = null;
  try {
    for (const file of validated.files) {
      const destination = path.join(tempDir, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content, 'utf8');
    }

    let packageData;
    try {
      packageData = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8'));
      if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) {
        throw new Error('package.json يجب أن يحتوي كائناً صالحاً.');
      }
      add('package-json', true);
    } catch (error) {
      add('package-json', false, error.message);
      return { passed: false, checks, summary: 'ملف package.json غير صالح.' };
    }

    let designContract = null;
    if (designArtifact) {
      try {
        const mapFile = validated.files.find(file => file.path === 'boss-design-map.json');
        if (!mapFile) throw new Error('الحزمة لا تحتوي على boss-design-map.json.');
        const map = JSON.parse(mapFile.content);
        designContract = validateDesignMap({
          map,
          designArtifact,
          files: validated.files
        });
        add('design-to-file-map', true,
          designContract.mappedElements + ' design elements mapped to ' +
          designContract.mappedFiles + ' generated files; ' +
          designContract.acceptanceTestCases.length + ' executable acceptance cases declared.');
      } catch (error) {
        add('design-to-file-map', false, error.message);
      }
    } else {
      add('design-to-file-map', false,
        'وثيقة التصميم المعتمدة مطلوبة للتحقق من اختبارات القبول.');
    }

    const lockFile = validated.files.find(file => file.path === 'package-lock.json');
    if (!lockFile) {
      add('dependency-preflight', false,
        'الحزمة لا تحتوي على package-lock.json؛ يجب إنشاء ملف قفل حقيقي قبل اعتمادها.');
    } else {
      try {
        const lockData = JSON.parse(lockFile.content);
        const preflight = validateDependencyPreflight({ packageData, lockData });
        add('dependency-preflight', preflight.passed, preflight.errors.join('; '));
      } catch (error) {
        add('dependency-preflight', false, 'ملف package-lock.json غير صالح: ' + error.message);
      }
    }

    let manifest;
    try {
      const manifestFile = validated.files.find(file => file.path === 'boss-manifest.json');
      if (!manifestFile) throw new Error('الحزمة لا تحتوي على boss-manifest.json.');
      manifest = validateManifest(JSON.parse(manifestFile.content), packageData);
      add('boss-manifest', true);
      add('manifest-environment-names', true);
      add('manifest-start-script', true);
    } catch (error) {
      add('boss-manifest', false, error.message);
    }

    const javascriptFiles = validated.files.filter(file => /\.(?:js|cjs|mjs)$/.test(file.path));
    let syntaxPassed = true;
    for (const file of javascriptFiles) {
      const result = spawnSync(process.execPath, ['--check', path.join(tempDir, file.path)], {
        encoding: 'utf8', timeout: 15000
      });
      if (result.error || result.status !== 0) {
        syntaxPassed = false;
        add('javascript:' + file.path, false,
          (result.stderr || result.error?.message || 'فشل الفحص').slice(0, 2000));
      } else add('javascript:' + file.path, true);
    }
    if (javascriptFiles.length === 0) {
      add('javascript-files', false, 'لا توجد ملفات JavaScript للفحص.');
      syntaxPassed = false;
    }

    let jsonPassed = true;
    for (const file of validated.files.filter(item => item.path.endsWith('.json'))) {
      try {
        JSON.parse(file.content);
        add('json:' + file.path, true);
      } catch (error) {
        jsonPassed = false;
        add('json:' + file.path, false, error.message);
      }
    }

    let sandbox = { status: 'disabled', passed: null };
    let runtimeNodeModulesDir;
    let runtimeTree;
    if (process.env.BOSS_SANDBOX_ENABLED === 'YES') {
      const lockPath = path.join(tempDir, 'package-lock.json');
      const declaredDependencies = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
        .some(field => packageData[field] && Object.keys(packageData[field]).length > 0);
      let lockData = null;
      let lockError = null;
      if (fs.existsSync(lockPath)) {
        try { lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
        catch (error) { lockError = error; }
      }
      const lockedPackages = lockData?.packages && typeof lockData.packages === 'object'
        ? Object.keys(lockData.packages).filter(key => key !== '')
        : [];
      if (lockError || (declaredDependencies && !lockData?.packages)) {
        sandbox = {
          status: 'failed', executionStatus: 'not_confirmed', repairable: false, passed: false,
          details: 'A valid package-lock.json is required before dependency runtime tests can execute.'
        };
      } else if (lockedPackages.length > 0 && !dependencyArtifactDir) {
        sandbox = {
          status: 'failed', executionStatus: 'not_confirmed', repairable: false, passed: false,
          details: 'Verified offline dependency artifacts are required before runtime tests can execute.'
        };
      } else if (declaredDependencies && lockedPackages.length === 0) {
        sandbox = {
          status: 'failed', executionStatus: 'not_confirmed', repairable: false, passed: false,
          details: 'Declared dependencies are missing from package-lock.json.'
        };
      } else {
        try {
          if (lockedPackages.length > 0) {
            runtimeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-bot-runtime-'));
            const runtimeOutputDir = path.join(runtimeTempDir, 'verified-runtime');
            const unpacked = unpackVerifiedDependencies({
              artifactDir: dependencyArtifactDir,
              lockfilePath: lockPath,
              outputDir: runtimeOutputDir
            });
            runtimeTree = prepareRuntimeDependencyTree({
              outputDir: unpacked.outputDir,
              lockfilePath: lockPath
            });
            runtimeNodeModulesDir = runtimeTree.nodeModulesDir;
            add('verified-runtime-dependency-tree', true,
              'SHA-256 ' + runtimeTree.treeSha256 + '; ' + runtimeTree.fileCount +
              ' files; ' + runtimeTree.binWrappers.length + ' executable wrappers.');
          }
          fs.chmodSync(tempDir, 0o755);
          sandbox = {
            ...runSandboxTests({
              projectDir: tempDir, files: validated.files,
              image: process.env.BOSS_SANDBOX_IMAGE,
              runtimeNodeModulesDir,
              requiredAcceptanceTests: designContract?.acceptanceTestCases || []
            }),
            dependencyTreeSha256: runtimeTree?.treeSha256 || null
          };
        } catch (error) {
          sandbox = {
            status: 'failed', executionStatus: 'not_confirmed',
            repairable: false, passed: false,
            details: 'Verified dependency runtime preparation failed: ' + error.message
          };
        }
      }
      if (sandbox.status === 'failed') add('sandbox-runtime-tests', false, sandbox.details);
      else if (sandbox.status === 'passed') add('sandbox-runtime-tests', true, sandbox.details);
      else add('sandbox-runtime-tests', false,
        sandbox.reason || 'لم يتم تنفيذ اختبارات فعلية داخل بيئة معزولة.');
    }
    if (!checks.some(check => check.name === 'sandbox-runtime-tests')) {
      add('sandbox-runtime-tests', false,
        'التشغيل المعزول غير مفعّل؛ لا يمكن اعتبار المشروع مجتازاً دون تنفيذ الاختبارات.');
    }

    const passed = syntaxPassed && jsonPassed && checks.every(check => check.passed) &&
      sandbox.status === 'passed';
    return {
      passed, checks, manifest: manifest || null, sandbox,
      designFingerprint: designArtifact?.sourceFingerprint || null,
      summary: passed
        ? 'نجحت الفحوص الأساسية واختبارات القبول المعتمدة داخل البيئة المعزولة.'
        : 'فشلت بعض الاختبارات؛ يجب إصلاح الأخطاء وإعادة الاختبار.'
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (runtimeTempDir) fs.rmSync(runtimeTempDir, { recursive: true, force: true });
  }
}

module.exports = { testProjectBundle, validateManifest, scanForEmbeddedSecrets };
