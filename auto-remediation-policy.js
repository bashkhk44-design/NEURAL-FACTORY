'use strict';

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

function evaluateAutoRemediation(issue, history = [], {
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  windowMs = DEFAULT_WINDOW_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
} = {}) {
  if (!issue || typeof issue !== 'object') return { eligible: false, reason: 'invalid_issue' };
  if (!/^[1-9]\d*$/.test(String(issue.botId || ''))) return { eligible: false, reason: 'invalid_bot_id' };
  if (issue.active !== true) return { eligible: false, reason: 'bot_not_active' };
  if (issue.hasEncryptedToken !== true) return { eligible: false, reason: 'missing_encrypted_token' };

  const safeRestartStates = new Set([
    'stale_heartbeat:running',
    'unexpectedly_stopped:stopped'
  ]);
  if (!safeRestartStates.has(String(issue.reason) + ':' + String(issue.status))) {
    return { eligible: false, reason: 'manual_intervention_required' };
  }

  const events = Array.isArray(history) ? history : [];
  if (events.some(event => ['queued', 'processing'].includes(event.status))) {
    return { eligible: false, reason: 'remediation_already_pending' };
  }
  if (events.some(event => event.status === 'failed')) {
    return { eligible: false, reason: 'previous_repair_failed_manual_review' };
  }

  const timestamps = events
    .map(event => new Date(event.at).getTime())
    .filter(timestamp => Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= windowMs)
    .sort((a, b) => b - a);

  if (timestamps.length >= maxAttempts) {
    return { eligible: false, reason: 'attempt_limit_reached' };
  }
  if (timestamps.length && now - timestamps[0] < cooldownMs) {
    return { eligible: false, reason: 'cooldown_active' };
  }

  return {
    eligible: true,
    action: 'restart',
    reason: 'safe_transient_runtime_failure',
    attempt: timestamps.length + 1
  };
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_ATTEMPTS,
  evaluateAutoRemediation
};
