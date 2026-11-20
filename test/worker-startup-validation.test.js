'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkerEnvironment, getWorkerSslConfig } = require('../worker');

const validEnvironment = {
  DATABASE_URL: 'postgresql://test_user:test_password@localhost:5432/boss_test',
  BOTS_ENCRYPTION_KEY: 'a'.repeat(64)
};

test('worker startup accepts a PostgreSQL URL and a 32-byte hex encryption key', () => {
  assert.equal(validateWorkerEnvironment(validEnvironment), true);
});

test('worker startup rejects a missing database URL', () => {
  assert.throws(
    () => validateWorkerEnvironment({ BOTS_ENCRYPTION_KEY: validEnvironment.BOTS_ENCRYPTION_KEY }),
    /DATABASE_URL is required/
  );
});

test('worker startup rejects non-PostgreSQL database URLs', () => {
  assert.throws(
    () => validateWorkerEnvironment({
      ...validEnvironment,
      DATABASE_URL: 'https://example.invalid/database'
    }),
    /PostgreSQL protocol/
  );
});

test('worker startup rejects missing, short, and malformed encryption keys', () => {
  for (const key of ['', 'a'.repeat(62), 'g'.repeat(64)]) {
    assert.throws(
      () => validateWorkerEnvironment({ ...validEnvironment, BOTS_ENCRYPTION_KEY: key }),
      /32-byte hex key/
    );
  }
});

test('worker startup accepts uppercase hexadecimal encryption keys', () => {
  assert.equal(
    validateWorkerEnvironment({ ...validEnvironment, BOTS_ENCRYPTION_KEY: 'A'.repeat(64) }),
    true
  );
});

test('worker startup accepts supported database SSL modes', () => {
  for (const mode of ['require', 'disable']) {
    assert.equal(
      validateWorkerEnvironment({ ...validEnvironment, DATABASE_SSL: mode }),
      true
    );
  }
  assert.equal(validateWorkerEnvironment(validEnvironment), true);
});

test('worker startup rejects unknown database SSL modes instead of silently enabling TLS', () => {
  for (const mode of ['disabled', 'false', 'verify-full', '']) {
    assert.throws(
      () => validateWorkerEnvironment({ ...validEnvironment, DATABASE_SSL: mode }),
      /DATABASE_SSL must be either require or disable/
    );
  }
});

test('worker PostgreSQL connections verify TLS certificates by default and when required', () => {
  assert.equal(getWorkerSslConfig({}), true);
  assert.equal(getWorkerSslConfig({ DATABASE_SSL: 'require' }), true);
});

test('worker PostgreSQL TLS can only be disabled through explicit configuration', () => {
  assert.equal(getWorkerSslConfig({ DATABASE_SSL: 'disable' }), false);
});

test('worker startup rejects unsafe database pool and queue timing limits', () => {
  const invalidSettings = [
    ['WORKER_DB_POOL_MAX', '0'],
    ['WORKER_DB_POOL_MAX', '21'],
    ['WORKER_DB_POOL_MAX', '2.5'],
    ['QUEUE_POLL_INTERVAL_MS', '99'],
    ['QUEUE_POLL_INTERVAL_MS', '60001'],
    ['QUEUE_POLL_INTERVAL_MS', 'fast'],
    ['QUEUE_LEASE_SECONDS', '9'],
    ['QUEUE_LEASE_SECONDS', '86401'],
    ['QUEUE_LEASE_SECONDS', '10.5']
  ];

  for (const [name, value] of invalidSettings) {
    assert.throws(
      () => validateWorkerEnvironment({ ...validEnvironment, [name]: value }),
      new RegExp(name + ' must be an integer')
    );
  }
});

test('worker startup accepts bounded integer database pool and queue timing limits', () => {
  assert.equal(validateWorkerEnvironment({
    ...validEnvironment,
    WORKER_DB_POOL_MAX: '20',
    QUEUE_POLL_INTERVAL_MS: '100',
    QUEUE_LEASE_SECONDS: '86400'
  }), true);
});
