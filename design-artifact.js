'use strict';

const crypto = require('node:crypto');

const SOURCE_FIELDS = [
  ['description', 'هدف المشروع وطريقة عمله'],
  ['features', 'الميزات المطلوبة'],
  ['buttons', 'رحلة العميل والأزرار'],
  ['payments', 'الدفع'],
  ['languagesDesign', 'اللغة والتصميم'],
  ['extra', 'التفاصيل الإضافية']
];

const COLLECTIONS = [
  'flows',
  'states',
  'transitions',
  'messages',
  'buttons',
  'errorStates',
  'acceptanceTests'
];

function buildDesignSourceRequirements(spec, specVersion = 1) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('المواصفات المعتمدة غير صالحة للتصميم.');
  }

  const requirements = SOURCE_FIELDS
    .filter(([key]) => typeof spec[key] === 'string' && spec[key].trim())
    .map(([key, label]) => ({
      id: 'SPEC_' + key.replace(/([A-Z])/g, '_$1').toUpperCase(),
      field: key,
      label,
      approvedText: spec[key].trim().slice(0, 5000)
    }));

  if (!requirements.length) {
    throw new Error('لا توجد متطلبات نصية معتمدة يمكن ربط التصميم بها.');
  }

  const version = Number(specVersion);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('إصدار المواصفات المعتمدة غير صالح.');
  }

  const sourceFingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify(requirements))
    .digest('hex');

  return {
    schemaVersion: 1,
    specVersion: version,
    sourceFingerprint,
    requirements
  };
}

function cleanText(value, field, maxLength = 1200) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('حقل تصميم مطلوب مفقود: ' + field);
  }
  return value.trim().slice(0, maxLength);
}

function cleanId(value, field) {
  const id = cleanText(value, field, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('معرّف تصميم غير صالح: ' + field);
  }
  return id;
}

function cleanRefs(value, validRefs, field) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error('يجب ربط عنصر التصميم بمتطلب معتمد: ' + field);
  }

  const refs = [...new Set(value.map((ref) => cleanId(ref, field)))];
  for (const ref of refs) {
    if (!validRefs.has(ref)) {
      throw new Error('مرجع متطلب غير موجود أو غير معتمد: ' + ref);
    }
  }
  return refs;
}

function cleanCollection(value, name, validRefs, normalize) {
  if (!Array.isArray(value) || value.length > 80) {
    throw new Error('قائمة عناصر التصميم غير صالحة: ' + name);
  }
  return value.map((item, index) => normalize(item, name + '[' + index + ']', validRefs));
}

function normalizeDesignArtifact(raw, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('AI DESIGNER لم يُرجع وثيقة JSON صالحة.');
  }

  const requirements = source?.requirements;
  if (!Array.isArray(requirements) || !requirements.length) {
    throw new Error('مراجع المواصفات المعتمدة غير متاحة.');
  }

  const validRefs = new Set(requirements.map((item) => item.id));
  const coveredRefs = new Set();
  const registerRefs = (refs) => refs.forEach((ref) => coveredRefs.add(ref));

  const normalizeBase = (item, field) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('عنصر تصميم غير صالح: ' + field);
    }
    const refs = cleanRefs(item.requirementRefs, validRefs, field);
    registerRefs(refs);
    return { refs };
  };

  const normalizeStep = (item, field) => {
    const base = normalizeBase(item, field);
    return {
      id: cleanId(item.id, field + '.id'),
      actor: cleanText(item.actor, field + '.actor', 100),
      action: cleanText(item.action, field + '.action'),
      response: cleanText(item.response, field + '.response'),
      requirementRefs: base.refs
    };
  };

  const flows = cleanCollection(raw.flows, 'flows', validRefs, (item, field) => {
    const base = normalizeBase(item, field);
    if (!Array.isArray(item.steps) || !item.steps.length || item.steps.length > 40) {
      throw new Error('يجب أن يحتوي تدفق المحادثة على خطوات محددة: ' + field);
    }
    const steps = item.steps.map((step, index) =>
      normalizeStep(step, field + '.steps[' + index + ']')
    );
    const stepIds = steps.map((step) => step.id);
    if (new Set(stepIds).size !== stepIds.length) {
      throw new Error('معرّفات خطوات مكررة في ' + field);
    }
    return {
      id: cleanId(item.id, field + '.id'),
      title: cleanText(item.title, field + '.title', 180),
      goal: cleanText(item.goal, field + '.goal', 500),
      steps,
      requirementRefs: base.refs
    };
  });

  const states = cleanCollection(raw.states, 'states', validRefs, (item, field) => {
    const base = normalizeBase(item, field);
    return {
      id: cleanId(item.id, field + '.id'),
      name: cleanText(item.name, field + '.name', 120),
      description: cleanText(item.description, field + '.description'),
      requirementRefs: base.refs
    };
  });

  const stateIds = new Set(states.map((state) => state.id));
  if (stateIds.size !== states.length) {
    throw new Error('معرّفات الحالات مكررة.');
  }

  const transitions = cleanCollection(raw.transitions, 'transitions', validRefs, (item, field) => {
    const base = normalizeBase(item, field);
    const from = cleanId(item.from, field + '.from');
    const to = cleanId(item.to, field + '.to');
    if (!stateIds.has(from) || !stateIds.has(to)) {
      throw new Error('انتقال يشير إلى حالة غير معرفة: ' + field);
    }
    return {
      from,
      to,
      trigger: cleanText(item.trigger, field + '.trigger', 300),
      requirementRefs: base.refs
    };
  });

  const messages = cleanCollection(raw.messages, 'messages', validRefs, (item, field) => {
    const base = normalizeBase(item, field);
    return {
      id: cleanId(item.id, field + '.id'),
      when: cleanText(item.when, field + '.when', 300),
      text: cleanText(item.text, field + '.text', 2000),
      requirementRefs: base.refs
    };
  });

  const buttons = cleanCollection(raw.buttons, 'buttons', validRefs, (item, field) => {
    const base = normalizeBase(item, field);
    return {
      id: cleanId(item.id, field + '.id'),
      label: cleanText(item.label, field + '.label', 120),
      action: cleanText(item.action, field + '.action', 500),
      requirementRefs: base.refs
    };
  });

  const errorStates = cleanCollection(raw.errorStates, 'errorStates', validRefs, (item, field) => {
    const base = normalizeBase(item, field);
    return {
      id: cleanId(item.id, field + '.id'),
      condition: cleanText(item.condition, field + '.condition', 500),
      message: cleanText(item.message, field + '.message', 1000),
      recovery: cleanText(item.recovery, field + '.recovery', 1000),
      requirementRefs: base.refs
    };
  });

  const acceptanceTests = cleanCollection(raw.acceptanceTests, 'acceptanceTests', validRefs, (item, field) => {
    const base = normalizeBase(item, field);
    return {
      id: cleanId(item.id, field + '.id'),
      scenario: cleanText(item.scenario, field + '.scenario', 500),
      expected: cleanText(item.expected, field + '.expected', 1000),
      requirementRefs: base.refs
    };
  });

  if (!flows.length || !states.length || !acceptanceTests.length) {
    throw new Error('التصميم يحتاج تدفقات وحالات واختبارات قبول على الأقل.');
  }

  const uncovered = requirements
    .filter((item) => !coveredRefs.has(item.id))
    .map((item) => item.id);
  if (uncovered.length) {
    throw new Error('التصميم لم يغطِّ جميع المتطلبات المعتمدة: ' + uncovered.join(', '));
  }

  if (!Array.isArray(raw.openQuestions) || raw.openQuestions.length > 30) {
    throw new Error('قائمة الأسئلة المفتوحة غير صالحة.');
  }

  return {
    schemaVersion: 1,
    specVersion: source.specVersion,
    sourceFingerprint: source.sourceFingerprint,
    sourceRequirements: requirements,
    flows,
    states,
    transitions,
    messages,
    buttons,
    errorStates,
    acceptanceTests,
    openQuestions: raw.openQuestions
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim().slice(0, 500))
  };
}

function renderDesignDocument(artifact) {
  const lines = [
    '# وثيقة تصميم BOSS BOT MASTER',
    '',
    '- إصدار التصميم: ' + artifact.schemaVersion,
    '- إصدار المواصفات المعتمدة: ' + artifact.specVersion,
    '- بصمة المواصفات: ' + artifact.sourceFingerprint,
    '',
    '## المتطلبات المصدرية المعتمدة',
    ...artifact.sourceRequirements.map((item) =>
      '- ' + item.id + ' — ' + item.label + ': ' + item.approvedText
    ),
    '',
    '## تدفقات المحادثة'
  ];

  for (const flow of artifact.flows) {
    lines.push('', '### ' + flow.title, flow.goal, 'المراجع: ' + flow.requirementRefs.join(', '));
    for (const step of flow.steps) {
      lines.push(
        '- ' + step.id + ' | ' + step.actor + ': ' + step.action +
        ' → ' + step.response + ' [' + step.requirementRefs.join(', ') + ']'
      );
    }
  }

  const sections = [
    ['الحالات', artifact.states, (x) => x.id + ' — ' + x.name + ': ' + x.description],
    ['الانتقالات', artifact.transitions, (x) => x.from + ' → ' + x.to + ' عند: ' + x.trigger],
    ['الرسائل', artifact.messages, (x) => x.id + ' (' + x.when + '): ' + x.text],
    ['الأزرار', artifact.buttons, (x) => x.id + ' — ' + x.label + ': ' + x.action],
    ['حالات الخطأ والتعافي', artifact.errorStates, (x) => x.id + ': ' + x.condition + ' | ' + x.message + ' | ' + x.recovery],
    ['اختبارات القبول', artifact.acceptanceTests, (x) => x.id + ': ' + x.scenario + ' → ' + x.expected]
  ];

  for (const [title, items, format] of sections) {
    lines.push('', '## ' + title);
    for (const item of items) {
      lines.push('- ' + format(item) + ' [' + item.requirementRefs.join(', ') + ']');
    }
    if (!items.length) lines.push('- لا يوجد عنصر في هذا القسم وفق المواصفات المعتمدة.');
  }

  lines.push('', '## أسئلة ونواقص تحتاج توضيحاً');
  for (const question of artifact.openQuestions) lines.push('- ' + question);
  if (!artifact.openQuestions.length) lines.push('- لا توجد أسئلة مفتوحة مسجلة.');

  lines.push(
    '',
    '## حدود الاعتماد',
    'المراجع تثبت مصدر كل عنصر في المواصفات، لكنها لا تغني عن المراجعة البشرية لصحة تفسيره. لا يبدأ البناء قبل اعتماد التصميم ونقاط البناء.'
  );

  return lines.join('\n').slice(0, 30000);
}

module.exports = {
  buildDesignSourceRequirements,
  normalizeDesignArtifact,
  renderDesignDocument
};
