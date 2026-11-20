'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPostgresSslConfig } = require('../postgres-ssl');

test('PostgreSQL TLS certificate verification is enabled by default', () => {
  assert.equal(getPostgresSslConfig({}), true);
});

test('PostgreSQL TLS certificate verification remains enabled when required', () => {
  assert.equal(getPostgresSslConfig({ DATABASE_SSL: 'require' }), true);
});

test('PostgreSQL TLS can be disabled only by explicit supported configuration', () => {
  assert.equal(getPostgresSslConfig({ DATABASE_SSL: 'disable' }), false);
});

test('unsupported PostgreSQL SSL modes are rejected', () => {
  for (const mode of ['', 'false', 'disabled', 'verify-full', 'prefer']) {
    assert.throws(
      () => getPostgresSslConfig({ DATABASE_SSL: mode }),
      /DATABASE_SSL must be either require or disable/
    );
  }
});
