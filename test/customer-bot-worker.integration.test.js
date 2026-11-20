'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = Boolean(process.env.DATABASE_URL);
test('PostgreSQL workers claim different bots concurrently', { skip: !enabled }, async () => {
  const { Pool } = require('pg');
  const { claimNextBot } = require('../customer-bot-worker');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 4
  });
  const ids = [];
  try {
    const inserted = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext, token_iv, token_auth_tag)
      VALUES
        ('worker concurrency A', 'worker_concurrency_a', TRUE, 'cipher', 'iv', 'tag'),
        ('worker concurrency B', 'worker_concurrency_b', TRUE, 'cipher', 'iv', 'tag')
      RETURNING id
    `);
    ids.push(...inserted.rows.map(row => String(row.id)));
    const claimed = await Promise.all([
      claimNextBot(pool, 'integration-worker-a', 90),
      claimNextBot(pool, 'integration-worker-b', 90)
    ]);
    assert.equal(new Set(claimed).size, 2);
    assert.deepEqual([...claimed].sort(), [...ids].sort());
    const statuses = await pool.query(
      'SELECT bot_id, worker_id, status FROM bot_runtime_status WHERE bot_id = ANY($1::bigint[])',
      [ids]
    );
    assert.equal(statuses.rowCount, 2);
    assert.equal(new Set(statuses.rows.map(row => row.worker_id)).size, 2);
  } finally {
    if (ids.length) {
      await pool.query('DELETE FROM bot_runtime_status WHERE bot_id = ANY($1::bigint[])', [ids]);
      await pool.query('DELETE FROM telegram_bots WHERE id = ANY($1::bigint[])', [ids]);
    }
    await pool.end();
  }
});
