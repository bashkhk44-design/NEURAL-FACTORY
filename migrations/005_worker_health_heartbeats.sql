-- Independent worker heartbeats for accurate worker health monitoring.
BEGIN;
CREATE TABLE IF NOT EXISTS bot_worker_status (
  worker_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','stopped')),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bot_worker_status_heartbeat_idx
  ON bot_worker_status(status, last_heartbeat_at);

COMMIT;
