BEGIN;

CREATE INDEX IF NOT EXISTS bot_runtime_status_worker_heartbeat_idx
  ON bot_runtime_status(worker_id, last_heartbeat_at DESC);

CREATE INDEX IF NOT EXISTS bot_runtime_status_status_heartbeat_idx
  ON bot_runtime_status(status, last_heartbeat_at DESC);

COMMIT;
