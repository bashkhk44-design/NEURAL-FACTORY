-- Track ownership of each customer Telegram inbox lease.
-- Existing rows remain claimable; only active handlers acquire locked_by.
BEGIN;

ALTER TABLE bot_inbound_updates
  ADD COLUMN IF NOT EXISTS locked_by TEXT;

CREATE INDEX IF NOT EXISTS bot_inbound_updates_pending_order_idx
  ON bot_inbound_updates(bot_id, update_id)
  WHERE state <> 'processed';

COMMIT;
