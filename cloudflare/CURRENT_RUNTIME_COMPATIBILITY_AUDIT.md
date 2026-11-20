# Cloudflare runtime compatibility audit

Status: the current branch now contains a minimal Cloudflare edge-ingress adapter and a source dependency-boundary test. It is not deployed. No staging Hyperdrive ID, staging database binding, Telegram secret, Cloudflare API token, route, or webhook is configured.

## Current implementation

### Platform bot runtimes

- `telegram-master.js` is an explicit factory. Importing the module does not poll, acquire a runtime lock, or register process handlers. Its `createWebhookRuntime().handleUpdate(update)` path does not start polling.
- `intake-bot.js` exposes an injected runtime factory and a no-polling `createWebhookRuntime()`. Existing Node polling entry points remain available.
- Customer updates continue through the customer-only durable inbox and `createCustomerBot(...).handleUpdate(update)` in Node workers.
- Migration `007_platform_bot_inbox` adds a separate durable inbox for `master` and `intake`.
- Platform update enqueue is atomic: inbox row and queue job are inserted in one SQL statement, with identity-scoped deduplication.
- The platform dispatch handler validates job identity and fences inbox completion/failure to the current queue-worker lease.
- The Node queue worker registers system-bot job handlers only when `PLATFORM_BOT_WEBHOOK_MODE=enabled`; the default remains disabled. It requires distinct master/intake bot tokens and an admin ID.
- The existing Node webhook ingress exposes `/telegram/platform/master` and `/telegram/platform/intake` only when an independent platform secret resolver is configured. The two webhook secrets must be distinct, URL-safe, and independent from bot tokens.

### Cloudflare edge adapter

- `cloudflare/worker.mjs` handles only the platform master/intake ingress routes.
- It validates route identity, independent secret-token header, content type, bounded request body, and strict Telegram update IDs.
- It enqueues through the shared platform queue module and does not import the master/intake bot runtimes, `db.js`, Node HTTP servers, or queue workers.
- It creates one `pg.Client` per request using `HYPERDRIVE.connectionString`, then closes the client in a `finally` block. Hyperdrive owns the regional connection pool.
- `cloudflare/wrangler.staging.example.jsonc` is a non-deployable template with a placeholder Hyperdrive ID and platform mode disabled.
- Unit tests exercise the Worker handler with an injected PostgreSQL client and check the source dependency boundary. CI also runs a real Wrangler `deploy --dry-run` bundle with a credential-free config that has no Hyperdrive binding. This is not a live Hyperdrive connection or end-to-end staging test.

## Hyperdrive compatibility basis

The repository currently declares `pg ^8.23.1`, above Cloudflare's documented minimum `pg@8.16.3` for node-postgres with Hyperdrive. The Worker uses `nodejs_compat` and creates a new `Client` for each request, as recommended by Cloudflare.

Hyperdrive's default PostgreSQL TLS mode is `require`, which requires encryption and validates server certificates. Hyperdrive also supports `verify-ca` and `verify-full` when configured with the required CA certificate. The Worker does not disable TLS or set `rejectUnauthorized: false`.

References:
- https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/
- https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/
- https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/
- https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/

## Remaining blockers

1. Review the Wrangler dry-run output and keep Wrangler major version 4 in CI; the dry-run config intentionally has no Hyperdrive binding.
2. Create a dedicated, empty Neon staging database/branch and a new Hyperdrive configuration. Verify the exact origin database and hostname before binding it. Do not reuse the old prototype Hyperdrive ID.
3. Configure staging-only master/intake Telegram tokens and two independent webhook secrets in restricted environments.
4. Run staging end-to-end tests: Telegram webhook authentication, Hyperdrive enqueue, Node worker dispatch, lease recovery, and no cross-identity dispatch.
5. Add a deploy workflow scoped to the `cloudflare-staging` GitHub Environment only after the preceding gates pass.

## Explicitly not done

- No Cloudflare Worker deployment or route registration.
- No Hyperdrive ID or database credentials added to the repository.
- No production or staging database connection or migration.
- No Telegram `setWebhook` call.
- No production Render, Neon, tokens, secrets, or `BOTS_ENCRYPTION_KEY` changes.
- No deployment workflow yet.
