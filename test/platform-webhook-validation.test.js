'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlatformWebhookEnvironment } = require('../platform-webhook');

const valid = {
  DATABASE_URL: 'postgresql://boss:password@localhost:5432/boss_test',
  MASTER_WEBHOOK_SECRET: 'master_webhook_secret_abcdefghijklmnopqrstuvwxyz123456',
  INTAKE_WEBHOOK_SECRET: 'intake_webhook_secret_abcdefghijklmnopqrstuvwxyz123456',
  TELEGRAM_BOT_TOKEN: 'master-token-' + 'm'.repeat(40),
  INTAKE_BOT_TOKEN: 'intake-token-' + 'i'.repeat(40)
};

test('platform webhook accepts independent secrets and PostgreSQL configuration', () => {
  assert.equal(validatePlatformWebhookEnvironment(valid), true);
});

test('platform webhook accepts the explicit staging database target', () => {
  assert.equal(validatePlatformWebhookEnvironment({
    ...valid,
    BOSS_DATABASE_TARGET: 'staging',
    STAGING_DATABASE_URL: 'postgresql://staging:password@localhost:5432/staging',
    DATABASE_URL: 'postgresql://production:password@localhost:5432/production'
  }), true);
});

test('platform webhook rejects a missing or non-PostgreSQL database URL', () => {
  assert.throws(() => validatePlatformWebhookEnvironment({
    ...valid,
    DATABASE_URL: ''
  }), /DATABASE_URL is required/);
  assert.throws(() => validatePlatformWebhookEnvironment({
    ...valid,
    DATABASE_URL: 'https://example.invalid'
  }), /Database URL must use the PostgreSQL protocol/);
});

test('platform webhook requires strong, distinct master and intake secrets', () => {
  assert.throws(() => validatePlatformWebhookEnvironment({
    ...valid,
    MASTER_WEBHOOK_SECRET: 'short'
  }), /MASTER_WEBHOOK_SECRET must be 32-256 URL-safe characters/);
  assert.throws(() => validatePlatformWebhookEnvironment({
    ...valid,
    INTAKE_WEBHOOK_SECRET: valid.MASTER_WEBHOOK_SECRET
  }), /must be different/);
});

test('platform webhook secrets cannot reuse either Telegram bot API token', () => {
  for (const [secretName, tokenName] of [
    ['MASTER_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN'],
    ['MASTER_WEBHOOK_SECRET', 'INTAKE_BOT_TOKEN'],
    ['INTAKE_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN'],
    ['INTAKE_WEBHOOK_SECRET', 'INTAKE_BOT_TOKEN']
  ]) {
    assert.throws(() => validatePlatformWebhookEnvironment({
      ...valid,
      [secretName]: valid[tokenName]
    }), new RegExp(secretName + ' must be independent from ' + tokenName));
  }
});

test('platform webhook remains usable without bot tokens in the ingress process', () => {
  const { TELEGRAM_BOT_TOKEN, INTAKE_BOT_TOKEN, ...ingressOnly } = valid;
  assert.equal(validatePlatformWebhookEnvironment(ingressOnly), true);
});
