'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadProjectDb(pool) {
  const dbPath = require.resolve('../db');
  const projectPath = require.resolve('../project-db');
  const previousDb = require.cache[dbPath];
  const previousProject = require.cache[projectPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool, encryptSecret() {}, decryptSecret() {} }
  };
  delete require.cache[projectPath];
  const projectDb = require('../project-db');
  return {
    projectDb,
    restore() {
      delete require.cache[projectPath];
      delete require.cache[dbPath];
      if (previousDb) require.cache[dbPath] = previousDb;
      if (previousProject) require.cache[projectPath] = previousProject;
    }
  };
}

test('conversation inserts use Telegram update metadata to suppress redelivered duplicate messages', async () => {
  let captured;
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      captured = { sql, params };
      if (calls.length === 1) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ id: '77', content: 'hello' }] };
    }
  };
  const loaded = loadProjectDb(pool);
  try {
    await loaded.projectDb.addConversationMessage({
      telegramUserId: '123',
      projectId: 456,
      role: 'client',
      content: 'hello',
      metadata: { telegram_update_id: '9001' }
    });
    assert.match(calls[0].sql, /ON CONFLICT \(project_id, role, \(metadata->>'telegram_update_id'\), content\)/);
    assert.match(calls[0].sql, /WHERE \(metadata \? 'telegram_update_id'\)/);
    assert.equal(calls[0].params[4], JSON.stringify({ telegram_update_id: '9001' }));
    assert.equal(calls.length, 2, 'duplicate conflict must be resolved by reading the existing owned message');
    assert.match(calls[1].sql, /m.metadata->>'telegram_update_id' = \$5/);
    assert.equal(calls[1].params[4], '9001');
    assert.equal(calls[1].params[0], 456);
    assert.equal(calls[1].params[1], '123');
    assert.equal(calls[1].params[2], 'client');
    assert.equal(calls[1].params[3], 'hello');
  } finally {
    loaded.restore();
  }
});
