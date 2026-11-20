'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateProjectArchitectureReadiness,
  normalizeProjectArchitecture
} = require('../project-architecture');

function completeArchitecture() {
  return {
    hostingPlacement: 'split',
    componentHosts: [
      { component: 'telegram_bot', placement: 'factory' },
      { component: 'website', placement: 'customer' },
      { component: 'database', placement: 'customer' }
    ],
    accountOwner: 'customer',
    dataOwner: 'customer',
    secretsOwner: 'customer',
    operationsOwner: 'factory support with customer ownership',
    rollbackOwner: 'customer',
    adminSurface: 'telegram_only',
    adminReason: 'Project operators can safely manage all required tasks in Telegram.'
  };
}

test('normalizes hybrid project placement and a Telegram-only optional admin surface', () => {
  const result = evaluateProjectArchitectureReadiness(completeArchitecture(), {
    requiredComponents: ['telegram_bot', 'website', 'database']
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.architecture.hostingPlacement, 'split');
  assert.equal(result.architecture.adminSurface, 'telegram_only');
});

test('fails closed when hosting, ownership, component mapping, or admin decisions are unresolved', () => {
  const result = evaluateProjectArchitectureReadiness({
    hostingPlacement: 'undecided',
    adminSurface: 'undecided'
  }, {
    requiredComponents: ['telegram_bot', 'website']
  });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes('hosting_placement_unresolved'));
  assert.ok(result.blockers.includes('component_host_missing:telegram_bot'));
  assert.ok(result.blockers.includes('component_host_missing:website'));
  assert.ok(result.blockers.includes('accountowner_unresolved'));
  assert.ok(result.blockers.includes('rollbackowner_unresolved'));
  assert.ok(result.blockers.includes('admin_surface_unresolved'));
});

test('optional admin policy permits no dashboard when the decision is explicit', () => {
  const architecture = completeArchitecture();
  architecture.adminSurface = 'none';
  architecture.adminReason = 'No separate admin interface is required for this project.';
  const result = evaluateProjectArchitectureReadiness(architecture, {
    requiredComponents: ['telegram_bot', 'website', 'database']
  });
  assert.equal(result.ready, true);
});

test('requires a reason for an explicit admin surface decision', () => {
  const architecture = completeArchitecture();
  architecture.adminReason = 'undecided';
  const result = evaluateProjectArchitectureReadiness(architecture);
  assert.ok(result.blockers.includes('admin_surface_reason_unresolved'));
});

test('rejects duplicate and unsupported component hosting entries', () => {
  const architecture = completeArchitecture();
  architecture.componentHosts.push({ component: 'website', placement: 'factory' });
  assert.throws(() => normalizeProjectArchitecture(architecture), /Invalid or duplicate/);
  architecture.componentHosts = [{ component: 'unknown', placement: 'factory' }];
  assert.throws(() => normalizeProjectArchitecture(architecture), /Invalid or duplicate/);
});

test('rejects malformed required component lists', () => {
  assert.throws(() => evaluateProjectArchitectureReadiness(completeArchitecture(), {
    requiredComponents: ['arbitrary_code']
  }), /Invalid required project components/);
});
