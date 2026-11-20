-- Deduplicate intake conversation writes when Telegram redelivers an update.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.client_conversations') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS client_conversations_telegram_update_dedupe_idx
      ON client_conversations (
        project_id,
        role,
        (metadata->>'telegram_update_id'),
        content
      )
      WHERE metadata ? 'telegram_update_id';
  END IF;
END $$;

COMMIT;
