# Cloudflare platform webhook Worker

This is an edge-only ingress adapter for the platform-owned Telegram bots:
- `POST /telegram/platform/master`
- `POST /telegram/platform/intake`

It validates the route identity, Telegram secret-token header, JSON content type,
body size, and Telegram `update_id`, then atomically enqueues the update through
the existing platform inbox/queue API. It does not create Telegram bot clients,
run AI jobs, or import the Node master/intake runtimes.

## Database connection

The Worker uses `pg.Client` with the `HYPERDRIVE.connectionString` binding.
It creates one short-lived client per request and always calls `end()`; Hyperdrive
owns the regional connection pool. Do not replace this with a process-wide
`pg.Pool` in the Worker.

The repository currently pins `pg` at `^8.23.1`, above Cloudflare's documented
minimum `8.16.3` for node-postgres with Hyperdrive. The Worker requires
`nodejs_compat`. Hyperdrive's default PostgreSQL TLS mode is `require`, which
validates server certificates; `verify-ca` and `verify-full` are available for
stricter configurations. Do not set `rejectUnauthorized: false` or disable TLS.

## Staging-only setup

1. Create a dedicated, empty Neon staging database/branch.
2. Create a new Hyperdrive configuration that points only to that staging
   database. Independently verify its origin hostname and database name.
3. Copy `wrangler.staging.example.jsonc` to a private local
   `wrangler.jsonc` and replace the placeholder with the verified staging
   Hyperdrive ID. Never reuse the old prototype Hyperdrive ID.
4. Configure Worker secrets `MASTER_WEBHOOK_SECRET` and
   `INTAKE_WEBHOOK_SECRET` separately. Each must be 32-256 URL-safe characters,
   and neither may equal its Telegram bot token.
5. Set `PLATFORM_BOT_WEBHOOK_MODE=enabled` only after the staging Node queue
   worker is configured with separate staging master/intake bot tokens and the
   staging database.
6. Keep the example's `workers_dev=false` until a reviewed staging route is
   deliberately configured.

The edge Worker does not need Telegram bot tokens or the BOTS encryption key.
Those remain in the isolated Node worker. No production credentials belong in
the Worker environment.

## Current limitations

- This Worker handles only platform master/intake webhook routes; customer
  webhook routing remains on the existing Node ingress.
- The Worker only enqueues. AI analysis, design, building, tests, deployment
  preflight, and bot runtime handlers remain in Node queue workers.
- No Hyperdrive ID, account ID, Cloudflare API token, route, webhook, or staging
  secret is configured by this source file.
- Do not deploy until the bundle-boundary tests pass and the staging Hyperdrive
  binding is verified to point to the dedicated empty staging database.
