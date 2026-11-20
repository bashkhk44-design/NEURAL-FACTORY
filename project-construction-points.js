'use strict';

const SPEC_POINT_FIELDS = [
  ['description', 'هدف المشروع'],
  ['features', 'الميزات المطلوبة'],
  ['buttons', 'الأزرار ورحلة العميل'],
  ['payments', 'الدفع'],
  ['languagesDesign', 'اللغة والتصميم'],
  ['extra', 'تفاصيل إضافية']
];

function buildConstructionPoints(spec = {}) {
  const source = spec && typeof spec === 'object' && !Array.isArray(spec)
    ? spec
    : {};

  const sections = SPEC_POINT_FIELDS
    .filter(([key]) => typeof source[key] === 'string' && source[key].trim())
    .map(([key, label]) => ({
      key,
      label,
      value: source[key].trim().slice(0, 3000)
    }));

  return {
    source: 'approved_project_specification',
    sections
  };
}

module.exports = { buildConstructionPoints };
