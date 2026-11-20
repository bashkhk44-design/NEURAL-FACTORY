'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createAutoRemediator } = require('../auto-remediation');

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl && process.env.DATABASE_SSL === 'disable');

test('automatic remediation creates one auditable restart command and blocks a duplicate', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 3 });
  let botId;
  try {
    const inserted = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('auto remediation fixture', 'auto_remediation_fixture_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    botId = inserted.rows[0].id;
    await pool.query(`
      INSERT INTO bot_runtime_status (bot_id, status, worker_id, last_heartbeat_at)
      VALUES ($1, 'running', 'dead-worker', NOW() - INTERVAL '5 minutes')
    `, [botId]);

    const service = createAutoRemediator({ pool, staleAfterSeconds: 90 });
    const first = await service.consider(String(botId));
    assert.equal(first.queued, true);
    const second = await service.consider(String(botId));
    assert.equal(second.eligible, false);
    assert.equal(second.reason, 'remediation_already_pending');

    const rows = await pool.query(`
      SELECT a.status AS attempt_status, a.reason, a.command_id,
             c.status AS command_status, c.action, c.requested_by
      FROM bot_auto_remediation_attempts a
      JOIN bot_runtime_commands c ON c.id = a.command_id
      WHERE a.bot_id = $1
    `, [botId]);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].attempt_status, 'queued');
    assert.equal(rows.rows[0].reason, 'stale_heartbeat');
    assert.equal(rows.rows[0].command_status, 'queued');
    assert.equal(rows.rows[0].action, 'restart');
    assert.equal(rows.rows[0].requested_by, 'auto-remediation');
  } finally {
    if (botId) await pool.query('DELETE FROM telegram_bots WHERE id = $1', [botId]);
    await pool.end();
  }
});
