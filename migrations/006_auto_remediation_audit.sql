-- Durable, idempotent audit trail for bounded automatic bot recovery.
BEGIN;

CREATE TABLE IF NOT EXISTS bot_auto_remediation_attempts (
  id BIGSERIAL PRIMARY KEY,
  bot_id BIGINT NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  command_id BIGINT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','succeeded','failed')),
  reason TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT
);

ALTER TABLE bot_runtime_commands
  ADD COLUMN IF NOT EXISTS auto_remediation_attempt_id BIGINT
    REFERENCES bot_auto_remediation_attempts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bot_auto_remediation_one_pending_idx
  ON bot_auto_remediation_attempts(bot_id)
  WHERE status IN ('queued','processing');

CREATE INDEX IF NOT EXISTS bot_auto_remediation_history_idx
  ON bot_auto_remediation_attempts(bot_id, requested_at DESC);



COMMIT;
