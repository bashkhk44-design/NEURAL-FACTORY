# Cloudflare staging integration

Status: Worker source and local tests are prepared, but deployment remains disabled. No staging Hyperdrive binding, secret, route, webhook, or Cloudflare deployment has been configured. Production services and production Neon remain untouched.

## Deployment design

1. GitHub Actions runs the repository's existing quality checks on every push to
   `cloudflare-staging-integration` and on pull requests targeting `audit-hardening`.
2. `cloudflare/worker.mjs` now provides the edge-only master/intake webhook ingress. A real Wrangler bundle test and staging-only deploy workflow are still required.
3. Cloudflare deployment must use a dedicated Neon staging branch and a GitHub
   Environment named `cloudflare-staging` with restricted deployment approvals.
4. Cloudflare credentials and Telegram staging tokens must be GitHub Environment
   secrets, never committed to the repository.
5. Production Render, production Neon, production Telegram bot tokens/webhooks,
   and `BOTS_ENCRYPTION_KEY` remain untouched until a separately approved cutover.

## Required staging configuration (not yet populated)

GitHub Environment: `cloudflare-staging`

- `CLOUDFLARE_API_TOKEN` — secret with access only to the staging Worker.
- `CLOUDFLARE_ACCOUNT_ID` — staging account identifier (may be a variable).
- Staging-only Telegram bot tokens and webhook secrets.
- Hyperdrive binding connected only to a dedicated Neon staging database.
- A staging encryption key and staging-only bot records.

Do not copy production credentials into this environment.

## Current migration boundary

The previous Cloudflare prototype lives on the older
`cloudflare-webhook-prep` branch. That branch diverged substantially from the
current application branch. Its runtime files must be ported and reconciled with
the current source; merging or deploying that old branch wholesale could roll
back security and reliability fixes. This integration branch therefore starts
from the current application head and records the safe deployment contract
before any runtime code is moved.

## Acceptance criteria before enabling deployment

- Worker entrypoint uses the current platform queue API and avoids importing Node bot runtimes or the Node HTTP server.
- Worker unit tests, a static dependency-boundary test, and a credential-free Wrangler dry-run bundle test run in CI. The bundle test intentionally has no Hyperdrive binding.
- A newly created, independently verified staging-only Hyperdrive binding connection test passes.
- Master, intake, and customer webhook routes pass end-to-end staging tests.
- AI build/test pipeline is dispatched to isolated Node workers/queue; it is not
  silently treated as supported by the edge Worker.
- GitHub Actions deploys only the staging Worker after all checks pass.
- Production cutover remains a separate, explicitly approved operation.
