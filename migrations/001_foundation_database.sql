-- BOSS BOT MASTER database foundation v1
-- SAFE / ADDITIVE: does not delete, rename, rewrite, or backfill existing records.
-- Apply only after backup and review. Execute the entire file in one PostgreSQL session.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Preserve existing bot rows. Ownership links remain NULL until explicitly assigned.
ALTER TABLE telegram_bots
  ADD COLUMN IF NOT EXISTS client_id BIGINT,
  ADD COLUMN IF NOT EXISTS project_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS client_projects_id_client_id_uq
  ON client_projects(id, client_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'telegram_bots_client_id_fk'
      AND conrelid = 'telegram_bots'::regclass
  ) THEN
    ALTER TABLE telegram_bots
      ADD CONSTRAINT telegram_bots_client_id_fk
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'telegram_bots_project_client_fk'
      AND conrelid = 'telegram_bots'::regclass
  ) THEN
    ALTER TABLE telegram_bots
      ADD CONSTRAINT telegram_bots_project_client_fk
      FOREIGN KEY (project_id, client_id)
      REFERENCES client_projects(id, client_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS telegram_bots_client_idx
  ON telegram_bots(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_bots_project_idx
  ON telegram_bots(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bot_runtime_status (
  bot_id BIGINT PRIMARY KEY REFERENCES telegram_bots(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown','starting','running','retrying','stopped','conflict','unauthorized','error')),
  worker_id TEXT,
  last_started_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0 CHECK (restart_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bot_runtime_status_health_idx
  ON bot_runtime_status(status, last_heartbeat_at);

-- Telegram update_id is unique per bot, making webhook retries idempotent.
CREATE TABLE IF NOT EXISTS bot_inbound_updates (
  id BIGSERIAL PRIMARY KEY,
  bot_id BIGINT NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  update_id BIGINT NOT NULL,
  payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','processing','processed','failed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bot_id, update_id)
);
CREATE INDEX IF NOT EXISTS bot_inbound_updates_claim_idx
  ON bot_inbound_updates(state, available_at, id);

CREATE TABLE IF NOT EXISTS platform_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  client_id BIGINT REFERENCES clients(id) ON DELETE RESTRICT,
  project_id BIGINT,
  bot_id BIGINT REFERENCES telegram_bots(id) ON DELETE RESTRICT,
  idempotency_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','completed','retrying','failed','dead_letter','cancelled')),
  priority SMALLINT NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_type, idempotency_key)
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_jobs_project_client_fk'
      AND conrelid = 'platform_jobs'::regclass
  ) THEN
    ALTER TABLE platform_jobs
      ADD CONSTRAINT platform_jobs_project_client_fk
      FOREIGN KEY (project_id, client_id)
      REFERENCES client_projects(id, client_id)
      ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS platform_jobs_claim_idx
  ON platform_jobs(status, priority DESC, available_at, id);
CREATE INDEX IF NOT EXISTS platform_jobs_client_idx
  ON platform_jobs(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT REFERENCES clients(id) ON DELETE RESTRICT,
  project_id BIGINT,
  bot_id BIGINT REFERENCES telegram_bots(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  estimated_cost NUMERIC(14,6) NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','error','rate_limited','fallback')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_usage_project_client_fk
    FOREIGN KEY (project_id, client_id)
    REFERENCES client_projects(id, client_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ai_usage_client_created_idx
  ON ai_usage(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_bot_created_idx
  ON ai_usage(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  client_id BIGINT REFERENCES clients(id) ON DELETE RESTRICT,
  project_id BIGINT,
  bot_id BIGINT REFERENCES telegram_bots(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_audit_project_client_fk
    FOREIGN KEY (project_id, client_id)
    REFERENCES client_projects(id, client_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS platform_audit_client_created_idx
  ON platform_audit_logs(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_bot_created_idx
  ON platform_audit_logs(bot_id, created_at DESC);

-- A project-scoped record must always identify its owning client.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'telegram_bots_project_requires_client'
      AND conrelid = 'telegram_bots'::regclass
  ) THEN
    ALTER TABLE telegram_bots
      ADD CONSTRAINT telegram_bots_project_requires_client
      CHECK (project_id IS NULL OR client_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_jobs_project_requires_client'
      AND conrelid = 'platform_jobs'::regclass
  ) THEN
    ALTER TABLE platform_jobs
      ADD CONSTRAINT platform_jobs_project_requires_client
      CHECK (project_id IS NULL OR client_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_usage_project_requires_client'
      AND conrelid = 'ai_usage'::regclass
  ) THEN
    ALTER TABLE ai_usage
      ADD CONSTRAINT ai_usage_project_requires_client
      CHECK (project_id IS NULL OR client_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_audit_project_requires_client'
      AND conrelid = 'platform_audit_logs'::regclass
  ) THEN
    ALTER TABLE platform_audit_logs
      ADD CONSTRAINT platform_audit_project_requires_client
      CHECK (project_id IS NULL OR client_id IS NOT NULL);
  END IF;
END $$;



COMMIT;
