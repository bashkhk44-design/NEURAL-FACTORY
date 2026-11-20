-- Durable inbox for platform-owned Telegram bots (master and intake).
-- Kept separate from customer bot rows and the customer-only webhook inbox.
BEGIN;

CREATE TABLE IF NOT EXISTS platform_bot_inbound_updates (
  id BIGSERIAL PRIMARY KEY,
  bot_identity TEXT NOT NULL
    CHECK (bot_identity IN ('master', 'intake')),
  update_id BIGINT NOT NULL CHECK (update_id >= 0),
  payload JSONB NOT NULL
    CHECK (jsonb_typeof(payload) = 'object'),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','processing','processed','failed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bot_identity, update_id)
);

CREATE INDEX IF NOT EXISTS platform_bot_inbound_claim_idx
  ON platform_bot_inbound_updates(state, available_at, id);

CREATE INDEX IF NOT EXISTS platform_bot_inbound_identity_received_idx
  ON platform_bot_inbound_updates(bot_identity, received_at DESC);



COMMIT;
