'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const databaseUrl = process.env.DATABASE_URL;

test('platform Telegram inbox isolates master and intake identities with durable deduplication', {
  skip: !databaseUrl ? 'DATABASE_URL is required for the disposable PostgreSQL integration test' : false
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 3
  });
  const suffix = randomUUID();
  const updateId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const insertedIds = [];

  try {
    const master = await pool.query(
      `INSERT INTO platform_bot_inbound_updates (bot_identity, update_id, payload)
       VALUES ('master', $1, $2::jsonb) RETURNING id`,
      [updateId.toString(), JSON.stringify({ update_id: updateId.toString(), marker: suffix })]
    );
    insertedIds.push(master.rows[0].id);

    const duplicate = await pool.query(
      `INSERT INTO platform_bot_inbound_updates (bot_identity, update_id, payload)
       VALUES ('master', $1, '{}'::jsonb)
       ON CONFLICT (bot_identity, update_id) DO NOTHING
       RETURNING id`,
      [updateId.toString()]
    );
    assert.equal(duplicate.rowCount, 0, 'same platform identity and update ID must deduplicate');

    const intake = await pool.query(
      `INSERT INTO platform_bot_inbound_updates (bot_identity, update_id, payload)
       VALUES ('intake', $1, $2::jsonb) RETURNING id`,
      [updateId.toString(), JSON.stringify({ update_id: updateId.toString(), marker: suffix })]
    );
    insertedIds.push(intake.rows[0].id);
    assert.notEqual(String(master.rows[0].id), String(intake.rows[0].id),
      'master and intake must have independent inbox records for the same update ID');

    const rows = await pool.query(
      `SELECT bot_identity, update_id, state
       FROM platform_bot_inbound_updates
       WHERE id = ANY($1::bigint[])
       ORDER BY bot_identity`,
      [insertedIds]
    );
    assert.deepEqual(rows.rows.map(row => row.bot_identity), ['intake', 'master']);
    assert.ok(rows.rows.every(row => row.state === 'queued'));

    await assert.rejects(
      pool.query(
        `INSERT INTO platform_bot_inbound_updates (bot_identity, update_id, payload)
         VALUES ('customer:1', $1, '{}'::jsonb)`,
        [(updateId + 1n).toString()]
      ),
      error => error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO platform_bot_inbound_updates (bot_identity, update_id, payload)
         VALUES ('master', -1, '{}'::jsonb)`
      ),
      error => error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO platform_bot_inbound_updates (bot_identity, update_id, payload)
         VALUES ('master', $1, '[]'::jsonb)`,
        [(updateId + 2n).toString()]
      ),
      error => error.code === '23514'
    );

    const migration = await pool.query(
      `SELECT version FROM schema_migrations WHERE version = '007_platform_bot_inbox'`
    );
    assert.equal(migration.rowCount, 1);
  } finally {
    if (insertedIds.length) {
      await pool.query(
        'DELETE FROM platform_bot_inbound_updates WHERE id = ANY($1::bigint[])',
        [insertedIds]
      );
    }
    await pool.end();
  }
});
