# BOSS BOT MASTER — Database Foundation V1

## Current baseline verified in source
- PostgreSQL/Neon is the primary store.
- `clients` and `client_projects` already exist.
- `telegram_bots` currently stores name, username, active state and encrypted token fields.
- Customer bots currently run as Telegram long-polling tasks in one Node.js process.
- The main PostgreSQL pool is configured with max=3; the advisory-lock pool uses max=1.

## Design rules
1. Existing client, project, bot, conversation, specification and secret rows are preserved.
2. New ownership references on existing bots are nullable. Existing bots are deliberately not auto-assigned to a customer.
3. A bot's project and client must match through a composite foreign key.
4. Any record with a project_id must also include its client_id; database CHECK constraints enforce this for bots, jobs, AI usage and audit logs.
5. Telegram updates are idempotent per bot via UNIQUE(bot_id, update_id).
6. Jobs have bounded retries, explicit states and an index suitable for queue claiming.
7. AI usage and audit events are attributable to a client/project/bot where known.
8. No plaintext bot token is stored in these new tables.

## New schema
- `telegram_bots.client_id/project_id`: optional ownership link.
- `bot_runtime_status`: durable status/heartbeat/restart metadata.
- `bot_inbound_updates`: durable, deduplicated inbound update inbox.
- `platform_jobs`: generic durable work queue records.
- `ai_usage`: per-client/project/bot provider usage.
- `platform_audit_logs`: administrative/security audit trail.
- `schema_migrations`: applied migration ledger.

## Explicit migration runner
- Run `npm run db:migrate` only when an operator deliberately chooses to apply pending SQL migrations.
- The application startup path does not invoke the runner.
- The runner takes a PostgreSQL advisory lock, applies ordered SQL files, and records successful versions in `schema_migrations`.
- Use a disposable Neon branch first; do not point this command at production until the tested rollout is explicitly approved.

## Rollout safety
This PR only adds a migration file and documentation/tests. It does not execute SQL, change runtime code, change Render settings, or alter production data.

Before applying migration 001:
1. Confirm a recent Neon backup/restore point exists.
2. Run it against a disposable Neon branch first.
3. Verify existing bot count, client/project counts, and existing secrets remain unchanged.
4. Verify the new tables and constraints.
5. Apply to production during a quiet period, then verify row counts and application startup.

## Important non-goals in V1
- No automatic reassignment of existing bots.
- No switch from polling to webhooks yet.
- No worker deployment or queue consumer yet.
- No claim of 100-bot capacity until load/failure tests run.
- No automatic migration execution at application startup.

## Next implementation stage
Build an explicit migration runner and repository methods, then implement webhook ingress + queue consumers and separate worker processes. Keep the current polling runtime active until the replacement has passed staging and rollback tests.
