'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadProjectDbWithPool(pool) {
  const dbPath = require.resolve('../db');
  const modulePaths = [
    dbPath,
    require.resolve('../project-db'),
    require.resolve('../project-ai-jobs'),
    require.resolve('../project-approvals'),
    require.resolve('../project-release')
  ];
  const previous = new Map(modulePaths.map(path => [path, require.cache[path]]));
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool, encryptSecret() {}, decryptSecret() {} }
  };
  for (const path of modulePaths.slice(1)) delete require.cache[path];
  const projectDb = require('../project-db');
  return {
    projectDb,
    restore() {
      for (const path of modulePaths) {
        delete require.cache[path];
        if (previous.get(path)) require.cache[path] = previous.get(path);
      }
    }
  };
}

function createPool(queryHandler) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return queryHandler(String(sql), params, queries.length);
    },
    release() {}
  };
  return {
    queries,
    async connect() { return client; }
  };
}

test('new intake does not reuse a session whose project is not owned by the Telegram user', async () => {
  const pool = createPool(async (sql) => {
    if (sql.includes('SELECT s.project_id, s.step, s.data')) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('INSERT INTO clients')) return { rowCount: 1, rows: [{ id: '10' }] };
    if (sql.includes('INSERT INTO client_projects')) return { rowCount: 1, rows: [{ id: '20' }] };
    if (sql.includes('INSERT INTO client_intake_sessions')) {
      return { rowCount: 1, rows: [{ project_id: '20', step: 'business_type', data: {} }] };
    }
    return { rowCount: 0, rows: [] };
  });
  const loaded = loadProjectDbWithPool(pool);

  try {
    const result = await loaded.projectDb.createClientProjectWithSession({
      telegramUserId: '111',
      name: 'My project'
    });

    assert.equal(result.created, true);
    assert.equal(result.session.project_id, '20');

    const cleanupIndex = pool.queries.findIndex(q =>
      q.sql.includes('DELETE FROM client_intake_sessions s')
    );
    const createClientIndex = pool.queries.findIndex(q =>
      q.sql.includes('INSERT INTO clients')
    );
    assert.ok(cleanupIndex >= 0, 'stale session cleanup must run');
    assert.ok(cleanupIndex < createClientIndex, 'stale session must be removed before creating a new project');
    assert.match(pool.queries.find(q => q.sql.includes('SELECT s.project_id')).sql, /JOIN clients c/);
    assert.match(pool.queries.find(q => q.sql.includes('SELECT s.project_id')).sql, /c.telegram_user_id = \$1/);
  } finally {
    loaded.restore();
  }
});

test('new intake reuses an existing session only after its project ownership is verified', async () => {
  const validSession = { project_id: '42', step: 'features', data: { safe: true } };
  const pool = createPool(async (sql) => {
    if (sql.includes('SELECT s.project_id, s.step, s.data')) {
      return { rowCount: 1, rows: [validSession] };
    }
    if (sql.trim() === 'BEGIN' || sql.trim() === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rowCount: 0, rows: [] };
    assert.fail('valid owned session should return without creating or deleting records');
  });
  const loaded = loadProjectDbWithPool(pool);

  try {
    const result = await loaded.projectDb.createClientProjectWithSession({
      telegramUserId: '222',
      name: 'Another project'
    });

    assert.equal(result.created, false);
    assert.deepEqual(result.session, validSession);
    assert.equal(pool.queries.some(q => q.sql.includes('DELETE FROM client_intake_sessions')), false);
    assert.equal(pool.queries.some(q => q.sql.includes('INSERT INTO clients')), false);
  } finally {
    loaded.restore();
  }
});
