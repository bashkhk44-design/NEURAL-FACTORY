-- Distributed customer bot control commands.
-- Additive only: manager actions are queued for the worker that owns the bot.
BEGIN;

CREATE TABLE IF NOT EXISTS bot_runtime_commands (
  id BIGSERIAL PRIMARY KEY,
  bot_id BIGINT NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('start','stop','restart')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','completed','failed')),
  target_worker_id TEXT,
  requested_by TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bot_runtime_commands_claim_idx
  ON bot_runtime_commands(status, target_worker_id, id);



COMMIT;
