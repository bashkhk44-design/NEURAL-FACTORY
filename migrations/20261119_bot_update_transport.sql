-- Explicit per-customer-bot transport. Existing bots remain on polling.
BEGIN;

ALTER TABLE telegram_bots
  ADD COLUMN IF NOT EXISTS update_transport TEXT NOT NULL DEFAULT 'polling';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'telegram_bots_update_transport_check'
      AND conrelid = 'telegram_bots'::regclass
  ) THEN
    ALTER TABLE telegram_bots
      ADD CONSTRAINT telegram_bots_update_transport_check
      CHECK (update_transport IN ('polling', 'webhook'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS telegram_bots_active_transport_idx
  ON telegram_bots(update_transport, id)
  WHERE active = TRUE;

COMMIT;
