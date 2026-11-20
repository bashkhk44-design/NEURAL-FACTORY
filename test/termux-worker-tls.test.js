'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const script = fs.readFileSync('scripts/termux-worker.sh', 'utf8');

test('Termux worker preflight verifies PostgreSQL TLS certificates by default', () => {
  assert.match(
    script,
    /ssl:\s*process\.env\.DATABASE_SSL\s*===\s*'disable'\s*\?\s*false\s*:\s*true/
  );
  assert.doesNotMatch(script, /rejectUnauthorized\s*:\s*false/);
});

test('Termux test worker requires TLS and explicit expected database identity', () => {
  assert.match(script, /DATABASE_SSL !== 'require'/);
  assert.match(script, /BOSS_TEST_DATABASE_HOST/);
  assert.match(script, /BOSS_TEST_DATABASE_NAME/);
  assert.match(script, /url\.hostname\.toLowerCase\(\).*BOSS_TEST_DATABASE_HOST/);
  assert.match(script, /url\.pathname\.slice\(1\).*BOSS_TEST_DATABASE_NAME/);
});

test('Termux worker verifies the connected database name before starting', () => {
  assert.match(script, /result\.rows\[0\]\.db !== process\.env\.BOSS_TEST_DATABASE_NAME/);
  assert.match(script, /current_database\(\)/);
});
