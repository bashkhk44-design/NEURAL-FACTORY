'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConstructionPoints } = require('../project-construction-points');

test('construction points are derived only from the approved specification', () => {
  const result = buildConstructionPoints({
    description: 'بوت حجوزات',
    features: 'عرض المواعيد وتأكيد الحجز',
    payments: 'لا يوجد',
    unexpected: 'يجب ألا يظهر'
  });

  assert.equal(result.source, 'approved_project_specification');
  assert.deepEqual(result.sections.map(item => item.key), [
    'description', 'features', 'payments'
  ]);
  assert.equal(result.sections[0].value, 'بوت حجوزات');
  assert.equal(result.sections[2].value, 'لا يوجد');
});

test('construction points do not invent payment, address, or GPS requirements', () => {
  const result = buildConstructionPoints({
    description: 'مساعد ألعاب',
    features: 'إدارة المسابقات'
  });

  assert.deepEqual(result.sections.map(item => item.key), [
    'description', 'features'
  ]);
  assert.equal(JSON.stringify(result).includes('شام كاش'), false);
  assert.equal(JSON.stringify(result).includes('GPS'), false);
});

test('construction points trim and bound specification text', () => {
  const result = buildConstructionPoints({
    description: '  ' + 'x'.repeat(4000) + '  ',
    extra: '   '
  });

  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].value.length, 3000);
});

test('construction points safely handle invalid input', () => {
  assert.deepEqual(buildConstructionPoints(null), {
    source: 'approved_project_specification',
    sections: []
  });
});
