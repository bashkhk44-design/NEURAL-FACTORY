const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '..', 'migrations', '001_foundation_database.sql');
const docsPath = path.join(__dirname, '..', 'docs', 'DATABASE_FOUNDATION_V1.md');

test('database foundation migration is additive and transactional', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /^-- BOSS BOT MASTER database foundation v1/m);
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS client_id BIGINT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS project_id BIGINT/);
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.match(sql, /UNIQUE \(bot_id, update_id\)/);
  assert.match(sql, /telegram_bots_project_requires_client/);
  assert.match(sql, /platform_jobs_project_requires_client/);
  assert.match(sql, /ai_usage_project_requires_client/);
  assert.match(sql, /platform_audit_project_requires_client/);
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
});

test('database foundation documents that production migration is not auto-run', () => {
  const docs = fs.readFileSync(docsPath, 'utf8');
  assert.match(docs, /does not execute SQL/i);
  assert.match(docs, /No claim of 100-bot capacity/i);
  assert.match(docs, /disposable Neon branch/i);
});
