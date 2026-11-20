# Telegram platform-bot webhook design (staging only)

## Current status — 2026-11-19

The platform webhook architecture is implemented, deployed to the isolated Cloudflare staging Worker, and connected to the dedicated Neon staging database.

Verified staging health endpoint:
`https://boss-bot-platform-ingress-staging.bashkhk44.workers.dev/healthz`

Observed response:
`{"ok":true,"service":"platform-telegram-webhook-edge","database":"reachable"}`

The deployed staging Worker currently has `PLATFORM_BOT_WEBHOOK_MODE=disabled`. Therefore its health endpoint is available, but the Master/Intake webhook routes remain closed. No live Telegram inbound webhook test has been completed yet.

## Verified architecture

- Customer Telegram webhooks remain on the customer identity path and use the customer bot inbox and ownership checks.
- Master and Intake are separate system identities. Migration `007_platform_bot_inbox` gives them a dedicated durable inbox; update IDs are unique per identity.
- The platform queue atomically creates identity-scoped inbox rows and jobs. Master and Intake use distinct job types and lease-fenced dispatch.
- `telegram-master.js` and `intake-bot.js` expose explicit webhook runtimes with `handleUpdate(update)`; their normal Node polling entry points remain separate.
- The opt-in Node platform worker and Node ingress have separate Master/Intake routes and independent webhook secrets.
- `cloudflare/worker.mjs` is the edge ingress for the platform routes. It validates bounded JSON requests, authenticates the identity-specific secret, and durably enqueues through Hyperdrive using a short-lived `pg.Client`. It does not execute bot handlers or AI/build/test jobs.
- AI analysis, code generation, project builds, tests, deployment preflight, and Telegram update handling remain in durable Node workers.

## Staging infrastructure

- Neon project: `BOSS-BOT-PLATFORM-STAGING`.
- Neon branch: `pre-migrations-2026-11-19`, database `neondb`.
- Cloudflare Worker: `boss-bot-platform-ingress-staging`.
- Hyperdrive binding: `HYPERDRIVE`, configured only in the staging Wrangler config.
- Deployment workflow: `.github/workflows/deploy-cloudflare-platform-staging.yml`, manual confirmation required, scoped to the `boss-platform-staging` GitHub Environment.
- Staging webhook mode remains disabled.

## Security boundaries

- Never represent Master or Intake as customer `telegram_bots` records.
- Never put bot tokens or webhook secrets in queue payloads or logs.
- Master and Intake webhook secrets must be independent, URL-safe values and must not equal either bot API token.
- Do not put production tokens, production database credentials, or the production `BOTS_ENCRYPTION_KEY` in the Worker or staging environment.
- The Worker must not import Node host startup modules, `db.js`, or process-scoped `pg.Pool` instances. Its bounded `pg.Client` use is limited to Hyperdrive ingress.
- Keep `PLATFORM_BOT_WEBHOOK_MODE=disabled` until dedicated staging-only credentials are configured and the live staging test is explicitly approved.

## Validation completed

- Platform inbox migration and disposable PostgreSQL identity/deduplication tests passed.
- Atomic platform inbox + queue-job enqueue, distinct Master/Intake job types, and lease-fenced dispatch tests passed.
- Node worker wiring, webhook ingress validation, and Cloudflare Worker tests passed.
- Local HTTP-to-Neon integration verified Master/Intake identity separation and duplicate suppression.
- Local HTTP → Neon → queue → handler end-to-end test verified both identities were processed and queue jobs completed.
- Cloudflare staging health check verified the deployed Worker can reach Neon through Hyperdrive.
- GitHub Actions quality run `44554531430` completed successfully, including database migration/integration, Worker bundle/config validation, and isolated sandbox checks.

## Remaining acceptance gates

1. Configure dedicated staging-only Master and Intake Telegram bot tokens and independent webhook secrets. Never reuse production credentials.
2. Verify the dedicated private test chat and run the manual Telegram smoke test with a dedicated test bot.
3. Obtain explicit approval before changing the staging Worker from disabled mode or setting any Telegram webhook.
4. Run inbound Telegram webhook end-to-end tests through Cloudflare, Hyperdrive, Neon, the durable queue, and the Node platform worker.
5. Verify retries, duplicate updates, worker shutdown/recovery, monitoring, and rollback.
6. Complete security and operational review before considering production.

## Explicitly out of scope

- No production Render changes.
- No production Neon migrations or database connections.
- No production Telegram webhook set/delete calls or token changes.
- No changes to `BOTS_ENCRYPTION_KEY`.
- No Cloudflare production deployment.
- No automatic promotion from staging to production.

## Next step

Prepare dedicated staging-only Telegram test credentials and a private test chat. Then, with explicit approval, perform the live staging inbound-webhook test. The existing health check and local integration tests do not by themselves prove live Telegram delivery.
