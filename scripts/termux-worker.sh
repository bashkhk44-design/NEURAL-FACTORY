#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

CONFIG_FILE=".env.worker.local"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Missing $CONFIG_FILE. Copy .env.worker.example and fill it with TEST-branch values only."
  exit 1
fi

export DOTENV_CONFIG_PATH="$ROOT_DIR/$CONFIG_FILE"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 22 or newer in Termux."
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22 or newer is required. Current version: $(node -v)"
  exit 1
fi

if [[ ! -f package-lock.json ]]; then
  echo "package-lock.json is missing; refusing a non-reproducible install."
  exit 1
fi

npm ci --ignore-scripts --no-audit --no-fund

node <<'NODE'
require('dotenv').config();
const env = process.env;
if (env.BOSS_WORKER_MODE !== 'termux-test') throw new Error('BOSS_WORKER_MODE must be termux-test');
if (env.BOSS_TEST_DATABASE !== 'YES') throw new Error('BOSS_TEST_DATABASE must be YES');
if (!/^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL || '')) throw new Error('DATABASE_URL must be a PostgreSQL test-branch URL');
if (!/^[0-9a-fA-F]{64}$/.test(env.BOTS_ENCRYPTION_KEY || '')) throw new Error('BOTS_ENCRYPTION_KEY must be 64 hexadecimal characters');
if (env.DATABASE_SSL !== 'require') throw new Error('DATABASE_SSL must be require for the Termux test worker');
if (!env.BOSS_TEST_DATABASE_HOST || !env.BOSS_TEST_DATABASE_NAME) throw new Error('Expected test database host and name are required');
const url = new URL(env.DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid PostgreSQL URL');
if (url.hostname.toLowerCase() !== env.BOSS_TEST_DATABASE_HOST.trim().toLowerCase()) throw new Error('DATABASE_URL host does not match BOSS_TEST_DATABASE_HOST');
if (decodeURIComponent(url.pathname.slice(1)) !== env.BOSS_TEST_DATABASE_NAME) throw new Error('DATABASE_URL database name does not match BOSS_TEST_DATABASE_NAME');
NODE

echo
echo "WARNING: This worker can claim and process every eligible job in the configured database."
echo "Use a dedicated Neon TEST branch with test-only bot records and test-only queued jobs."
echo "Do not use production DATABASE_URL or production bot credentials."
echo
read -r -p "Type RUN-TEST-WORKER to continue: " CONFIRM
if [[ "$CONFIRM" != "RUN-TEST-WORKER" ]]; then
  echo "Cancelled. No worker was started."
  exit 1
fi

node <<'NODE'
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : true,
    max: 1,
    connectionTimeoutMillis: 10000
  });
  try {
    const result = await pool.query(
      "SELECT current_database() AS db, to_regclass('public.platform_jobs') IS NOT NULL AS has_jobs, to_regclass('public.telegram_bots') IS NOT NULL AS has_bots"
    );
    if (result.rows[0].db !== process.env.BOSS_TEST_DATABASE_NAME) {
      throw new Error('Connected database name does not match BOSS_TEST_DATABASE_NAME.');
    }
    if (!result.rows[0].has_jobs || !result.rows[0].has_bots) {
      throw new Error('Required queue schema is missing. Apply migrations to the TEST branch through the approved test workflow first.');
    }
    console.log('Read-only test database check passed; required queue tables exist.');
  } finally {
    await pool.end();
  }
})().catch(error => {
  console.error('Test database preflight failed:', error.message);
  process.exitCode = 1;
});
NODE

echo "Starting the queue worker against the configured TEST database. Press Ctrl+C to stop."
npm run start:worker
