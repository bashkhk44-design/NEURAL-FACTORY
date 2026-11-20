BEGIN;

-- Supports efficient discovery of bots that have never been claimed or whose
-- worker heartbeat expired. The status table itself is created by migration 001.
CREATE INDEX IF NOT EXISTS bot_runtime_status_lease_idx
  ON bot_runtime_status(status, last_heartbeat_at, bot_id);

CREATE INDEX IF NOT EXISTS telegram_bots_active_runtime_idx
  ON telegram_bots(id)
  WHERE active = TRUE;

COMMIT;
