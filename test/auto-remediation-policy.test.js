'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAutoRemediation } = require('../auto-remediation-policy');

const now = Date.parse('2026-11-17T12:00:00.000Z');
const baseIssue = {
  botId: '42',
  active: true,
  hasEncryptedToken: true,
  reason: 'stale_heartbeat',
  status: 'running'
};

test('allows a bounded restart for a stale active bot with an encrypted token', () => {
  assert.deepEqual(evaluateAutoRemediation(baseIssue, [], { now }), {
    eligible: true,
    action: 'restart',
    reason: 'safe_transient_runtime_failure',
    attempt: 1
  });
});

test('allows restart for an unexpectedly stopped active bot', () => {
  const issue = { ...baseIssue, reason: 'unexpectedly_stopped', status: 'stopped' };
  assert.equal(evaluateAutoRemediation(issue, [], { now }).eligible, true);
});

test('never auto-restarts conflict, unauthorized, error, retrying, or missing heartbeat states', () => {
  for (const [reason, status] of [
    ['conflict', 'conflict'],
    ['unauthorized', 'unauthorized'],
    ['error', 'error'],
    ['retrying', 'retrying'],
    ['missing_heartbeat', 'unknown']
  ]) {
    const result = evaluateAutoRemediation({ ...baseIssue, reason, status }, [], { now });
    assert.equal(result.eligible, false, reason);
    assert.equal(result.reason, 'manual_intervention_required', reason);
  }
});

test('requires an active bot and an encrypted token', () => {
  assert.equal(evaluateAutoRemediation({ ...baseIssue, active: false }, [], { now }).reason, 'bot_not_active');
  assert.equal(evaluateAutoRemediation({ ...baseIssue, hasEncryptedToken: false }, [], { now }).reason, 'missing_encrypted_token');
});

test('does not duplicate pending repairs or retry a failed repair automatically', () => {
  assert.equal(evaluateAutoRemediation(baseIssue, [{ status: 'processing' }], { now }).reason, 'remediation_already_pending');
  assert.equal(evaluateAutoRemediation(baseIssue, [{ status: 'failed' }], { now }).reason, 'previous_repair_failed_manual_review');
});

test('enforces cooldown and rolling attempt limit', () => {
  const recent = [{ status: 'succeeded', at: new Date(now - 60_000).toISOString() }];
  assert.equal(evaluateAutoRemediation(baseIssue, recent, { now }).reason, 'cooldown_active');

  const oldEnough = [10, 20, 30].map(minutes => ({
    status: 'succeeded',
    at: new Date(now - minutes * 60_000).toISOString()
  }));
  assert.equal(evaluateAutoRemediation(baseIssue, oldEnough, { now }).reason, 'attempt_limit_reached');
});

test('ignores history outside the rolling window', () => {
  const old = [{ status: 'succeeded', at: new Date(now - 2 * 60 * 60 * 1000).toISOString() }];
  assert.equal(evaluateAutoRemediation(baseIssue, old, { now }).attempt, 1);
});
