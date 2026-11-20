-- Recover manager commands abandoned by a crashed worker.
BEGIN;

ALTER TABLE bot_runtime_commands
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS bot_runtime_commands_recovery_idx
  ON bot_runtime_commands(status, claimed_at, id);

COMMIT;
