-- Deduplicate intake conversation writes when Telegram redelivers an update.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS client_conversations_telegram_update_dedupe_idx
  ON client_conversations (
    project_id,
    role,
    (metadata->>'telegram_update_id'),
    content
  )
  WHERE metadata ? 'telegram_update_id';

COMMIT;
