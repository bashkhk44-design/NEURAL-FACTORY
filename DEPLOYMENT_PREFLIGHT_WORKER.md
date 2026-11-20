# Isolated Deployment Preflight Worker

## Purpose

This is a dedicated queue consumer for the `deployment.preflight` job type. It loads an already-approved immutable release and its matching deployment authorization, then runs the existing Docker preflight contract.

It does **not** deploy, call Render or another hosting provider, change provider settings, read/decrypt project secret values, or approve execution.

## Queue flow

1. A manager requests a preflight from the Telegram manager bot.
2. The bot validates the approved release and immutable authorization, then queues a durable `deployment.preflight` job.
3. The dedicated worker claims only `deployment.preflight` jobs.
4. The worker loads the release, authorization, environment variable names, and previous approved release from PostgreSQL.
5. The worker runs the existing pinned-image Docker preflight with `--network=none`, read-only artifact mounts, non-root user, dropped capabilities, and bounded resources.
6. The result is stored in `platform_jobs.payload.result`. The manager bot can display the latest result.
7. Target configuration and a separate exact execution approval remain absent in this phase. Therefore final readiness remains false and execution is always denied.

## Required isolated-worker environment

- `DEPLOYMENT_PREFLIGHT_WORKER_ENABLED=true`
- `DATABASE_URL` pointing to a disposable test database during initial validation
- `BOSS_SANDBOX_IMAGE` set to an immutable image reference pinned by `@sha256:...`
- Optional: `DATABASE_SSL`, `DEPLOYMENT_PREFLIGHT_DB_POOL_MAX`, `DEPLOYMENT_PREFLIGHT_POLL_INTERVAL_MS`, `DEPLOYMENT_PREFLIGHT_LEASE_SECONDS`

Start only as a separate worker process:

`npm run start:deployment-preflight-worker`

The process intentionally does not require `TELEGRAM_BOT_TOKEN` or `BOTS_ENCRYPTION_KEY`. Do not run it in the manager web service. The host must provide a Docker daemon and the exact pinned image must already be present locally because the sandbox uses `--pull=never`. Docker daemon access is effectively host-privileged, so run this process only on a dedicated isolated runner host with no unrelated sensitive workloads; never expose the Docker socket to customer containers or the manager web service.

## Safety and deployment boundary

- The generic queue worker now claims only job types for which it has registered handlers. The deployment worker cannot consume Telegram update jobs, and the Telegram worker cannot consume deployment preflight jobs.
- Jobs are bound to release ID, project ID, immutable artifact digest, requester, and the current digest of configured environment variable names.
- Only environment variable names are queried from `project_secrets`; secret columns and secret values are never read.
- The sandbox receives placeholder values for required environment variables, not real customer secrets.
- The sandbox has no network access. No provider credentials are passed to it.
- `executionAllowed` and `deployed` are hard-coded false in the worker result.
- The result distinguishes an attempted preflight from confirmed container execution (a reported Node runtime); a missing Docker daemon or invalid sandbox setup is never reported as a confirmed container run.
- A successful preflight is evidence for a later manual review, not deployment authorization.
- Do not point this worker at the production database or deploy it before the separate disposable-database validation and explicit production approval.
