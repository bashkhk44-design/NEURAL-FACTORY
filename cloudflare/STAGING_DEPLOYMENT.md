# Cloudflare staging deployment status

Status: the isolated staging ingress Worker is deployed and its database health check is verified. Telegram webhook intake remains intentionally disabled.

## Verified staging resources

- Worker: `boss-bot-platform-ingress-staging`
- Worker URL: `https://boss-bot-platform-ingress-staging.bashkhk44.workers.dev`
- Health endpoint: `/healthz`
- Health response verified on 2026-11-19: `{"ok":true,"service":"platform-telegram-webhook-edge","database":"reachable"}`
- Neon project: `BOSS-BOT-PLATFORM-STAGING`
- Neon branch: `pre-migrations-2026-11-19`
- Database: `neondb`
- Hyperdrive binding: `HYPERDRIVE`, configured in `cloudflare/wrangler.staging.jsonc`
- Staging Worker mode: `PLATFORM_BOT_WEBHOOK_MODE=disabled`

The staging deploy is isolated by `.github/workflows/deploy-cloudflare-platform-staging.yml`. It requires the manual confirmation string `DEPLOY-BOSS-STAGING` and uses the `boss-platform-staging` GitHub Environment. The workflow verifies the staging Worker name, Hyperdrive binding, and disabled webhook mode before deployment.

## What has been verified

1. The Neon staging schema and migrations were applied and checked for idempotency.
2. The staging Hyperdrive connection was exercised through the deployed Worker health endpoint.
3. The Worker returned a successful database reachability result.
4. Local HTTP-to-Neon tests verified identity-scoped Master/Intake enqueue and duplicate suppression.
5. Local end-to-end tests verified HTTP ingress, queue dispatch, handler completion, and processed inbox states.
6. GitHub Actions quality run `44554531430` completed with conclusion `success`, including database migration/integration, Worker bundle/config validation, and isolated sandbox checks.

## Remaining acceptance gates

1. Configure dedicated staging-only Master and Intake Telegram bot credentials and independent webhook secrets. Never reuse production credentials.
2. Run a controlled live Telegram test using only dedicated test bots and a private test chat.
3. Enable the staging webhook mode only after the staging credentials and worker runtime are verified, with explicit approval for that change.
4. Verify inbound Telegram delivery through the staging Worker, Neon queue, and Node worker, including retries and duplicate updates.
5. Complete operational monitoring, rollback, and security review before any production planning.

## Safety boundaries

- Keep `PLATFORM_BOT_WEBHOOK_MODE=disabled` in Cloudflare Staging until the live-test prerequisites are met and the change is explicitly approved.
- Do not change production Render, Neon, Telegram tokens/webhooks, or encryption keys.
- Do not promote staging automatically to production.
- The health endpoint proves database reachability; it does not prove live Telegram webhook delivery or bot replies.
- The Telegram live smoke workflow is separate: it sends one quiet message using a dedicated test bot and private test chat. It does not test inbound webhook processing.

## Current next step

Prepare and verify dedicated staging-only Telegram test credentials and private test chat, then perform the explicitly approved live staging test. No production deployment is authorized by this document.
