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
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return { rowCount: 0, rows: [] };
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
    assert.match(captured.sql, /ON CONFLICT \(project_id, role, \(metadata->>'telegram_update_id'\), content\)/);
    assert.match(captured.sql, /WHERE \(metadata \? 'telegram_update_id'\)/);
    assert.equal(captured.params[4], JSON.stringify({ telegram_update_id: '9001' }));
  } finally {
    loaded.restore();
  }
});
