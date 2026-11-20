'use strict';

function collectDesignElements(artifact) {
  if (!artifact || typeof artifact !== 'object' ||
      !Array.isArray(artifact.sourceRequirements)) {
    throw new Error('وثيقة التصميم المعتمدة غير صالحة.');
  }

  const groups = [
    ['flow', artifact.flows, item => item.id],
    ['step', (artifact.flows || []).flatMap(item => item.steps || []), item => item.id],
    ['state', artifact.states, item => item.id],
    ['transition', artifact.transitions, (item, index) =>
      'transition_' + String(index + 1).padStart(4, '0')],
    ['message', artifact.messages, item => item.id],
    ['button', artifact.buttons, item => item.id],
    ['errorState', artifact.errorStates, item => item.id],
    ['acceptanceTest', artifact.acceptanceTests, item => item.id]
  ];

  const elements = [];
  for (const [type, items, getId] of groups) {
    if (!Array.isArray(items)) {
      throw new Error('قائمة عناصر التصميم غير صالحة: ' + type);
    }
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || !Array.isArray(item.requirementRefs)) {
        throw new Error('عنصر تصميم بلا مراجع معتمدة: ' + type + '[' + index + ']');
      }
      elements.push({
        designType: type,
        designId: getId(item, index),
        requirementRefs: [...new Set(item.requirementRefs)].sort()
      });
    });
  }

  if (!elements.length) throw new Error('وثيقة التصميم لا تحتوي عناصر قابلة للبناء.');
  return elements;
}

function validateDesignMap({ map, designArtifact, files }) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('boss-design-map.json يجب أن يحتوي كائناً صالحاً.');
  }

  if (map.schemaVersion !== 1 ||
      map.specVersion !== designArtifact?.specVersion ||
      map.sourceFingerprint !== designArtifact?.sourceFingerprint) {
    throw new Error('بصمة أو إصدار خريطة البناء لا يطابق التصميم المعتمد.');
  }

  const allowedKeys = new Set(['schemaVersion', 'specVersion', 'sourceFingerprint', 'mappings']);
  for (const key of Object.keys(map)) {
    if (!allowedKeys.has(key)) throw new Error('حقل غير مسموح في خريطة البناء: ' + key);
  }

  if (!Array.isArray(map.mappings) || map.mappings.length > 1000) {
    throw new Error('قائمة روابط التصميم إلى الملفات غير صالحة.');
  }

  const actualFiles = new Set(files.map(file => file.path));
  const expected = collectDesignElements(designArtifact);
  const expectedByKey = new Map(expected.map(item => [
    item.designType + ':' + item.designId, item
  ]));
  const seen = new Set();
  const acceptanceTestCases = [];

  for (const mapping of map.mappings) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new Error('رابط تصميم غير صالح.');
    }

    const key = String(mapping.designType || '') + ':' + String(mapping.designId || '');
    const source = expectedByKey.get(key);
    if (!source) throw new Error('خريطة البناء تشير إلى عنصر تصميم غير معتمد: ' + key);
    if (seen.has(key)) throw new Error('عنصر تصميم مكرر في خريطة البناء: ' + key);
    seen.add(key);

    if (!Array.isArray(mapping.filePaths) || !mapping.filePaths.length) {
      throw new Error('عنصر التصميم غير مربوط بأي ملف: ' + key);
    }

    const allowedMappingKeys = new Set([
      'designType', 'designId', 'requirementRefs', 'filePaths', 'testCases'
    ]);
    for (const field of Object.keys(mapping)) {
      if (!allowedMappingKeys.has(field)) {
        throw new Error('حقل غير مسموح في رابط التصميم: ' + field);
      }
    }

    const paths = [...new Set(mapping.filePaths)];
    for (const filePath of paths) {
      if (typeof filePath !== 'string' || !actualFiles.has(filePath) ||
          filePath === 'boss-design-map.json') {
        throw new Error('مسار ملف غير موجود في خريطة البناء: ' + String(filePath));
      }
    }

    if (source.designType === 'acceptanceTest') {
      if (!Array.isArray(mapping.testCases) || mapping.testCases.length !== 1) {
        throw new Error('اختبار القبول يجب أن يرتبط بحالات اختبار منفذة فعلياً: ' + key);
      }
      for (const testCase of mapping.testCases) {
        const marker = '[BOSS_ACCEPTANCE:' + source.designId + ']';
        if (!testCase || typeof testCase !== 'object' ||
            Object.keys(testCase).some(field => !['filePath', 'testName'].includes(field)) ||
            typeof testCase.filePath !== 'string' ||
            typeof testCase.testName !== 'string' ||
            !actualFiles.has(testCase.filePath) ||
            !paths.includes(testCase.filePath) ||
            !testCase.filePath.split('/').some(part => part === 'test' || part === 'tests') ||
            !/\.(?:test|spec)\.(?:js|cjs|mjs)$/.test(testCase.filePath) ||
            !testCase.testName.startsWith(marker) ||
            testCase.testName.length > 240) {
          throw new Error('حالة اختبار القبول غير صالحة أو غير مرتبطة بملف اختبار: ' + key);
        }
        acceptanceTestCases.push({
          acceptanceTestId: source.designId,
          marker,
          filePath: testCase.filePath,
          testName: testCase.testName
        });
      }
    } else if (mapping.testCases !== undefined) {
      throw new Error('حالات التنفيذ مسموحة لاختبارات القبول فقط: ' + key);
    }

    if (!Array.isArray(mapping.requirementRefs)) {
      throw new Error('مراجع المتطلبات مفقودة من خريطة البناء: ' + key);
    }

    const refs = [...new Set(mapping.requirementRefs)].sort();
    if (JSON.stringify(refs) !== JSON.stringify(source.requirementRefs)) {
      throw new Error('مراجع خريطة البناء لا تطابق التصميم المعتمد: ' + key);
    }
  }

  const missing = expected
    .filter(item => !seen.has(item.designType + ':' + item.designId))
    .map(item => item.designType + ':' + item.designId);

  if (missing.length) {
    throw new Error('عناصر تصميم لم يربطها AI BUILDER بملفات: ' + missing.join(', '));
  }

  return {
    passed: true,
    mappedElements: expected.length,
    mappedFiles: new Set(map.mappings.flatMap(item => item.filePaths)).size,
    acceptanceTestCases,
    sourceFingerprint: map.sourceFingerprint
  };
}

module.exports = { collectDesignElements, validateDesignMap };
