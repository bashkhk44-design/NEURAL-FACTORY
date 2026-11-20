'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getDatabaseUrl,
  getDirectDatabaseUrl
} = require('../database-config');

const productionUrl = 'postgresql://prod:secret@production.example/neondb';
const stagingUrl = 'postgresql://stage:secret@staging.example/neondb';

test('default target preserves DATABASE_URL behavior', () => {
  assert.equal(getDatabaseUrl({ DATABASE_URL: productionUrl }), productionUrl);
});

test('production target uses DATABASE_URL', () => {
  assert.equal(getDatabaseUrl({
    BOSS_DATABASE_TARGET: 'production',
    DATABASE_URL: productionUrl,
    STAGING_DATABASE_URL: stagingUrl
  }), productionUrl);
});

test('staging target uses STAGING_DATABASE_URL only', () => {
  assert.equal(getDatabaseUrl({
    BOSS_DATABASE_TARGET: 'staging',
    DATABASE_URL: productionUrl,
    STAGING_DATABASE_URL: stagingUrl
  }), stagingUrl);
});

test('staging refuses to fall back when STAGING_DATABASE_URL is missing', () => {
  assert.throws(() => getDatabaseUrl({
    BOSS_DATABASE_TARGET: 'staging',
    DATABASE_URL: productionUrl
  }), /STAGING_DATABASE_URL is required/);
});

test('staging direct connection ignores DATABASE_DIRECT_URL', () => {
  assert.equal(getDirectDatabaseUrl({
    BOSS_DATABASE_TARGET: 'staging',
    DATABASE_URL: productionUrl,
    STAGING_DATABASE_URL: stagingUrl,
    DATABASE_DIRECT_URL: productionUrl
  }), stagingUrl);
});

test('non-staging direct connection preserves DATABASE_DIRECT_URL', () => {
  assert.equal(getDirectDatabaseUrl({
    DATABASE_URL: productionUrl,
    DATABASE_DIRECT_URL: stagingUrl
  }), stagingUrl);
});

test('unknown database target is rejected', () => {
  assert.throws(() => getDatabaseUrl({
    BOSS_DATABASE_TARGET: 'other',
    DATABASE_URL: productionUrl
  }), /must be staging or production/);
});

test('non-PostgreSQL URLs are rejected', () => {
  assert.throws(() => getDatabaseUrl({
    BOSS_DATABASE_TARGET: 'staging',
    STAGING_DATABASE_URL: 'https://example.invalid'
  }), /PostgreSQL protocol/);
});

test('unknown target is rejected even when direct URL is configured', () => {
  assert.throws(() => getDirectDatabaseUrl({
    BOSS_DATABASE_TARGET: 'other',
    DATABASE_URL: productionUrl,
    DATABASE_DIRECT_URL: stagingUrl
  }), /must be staging or production/);
});
