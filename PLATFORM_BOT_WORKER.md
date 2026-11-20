# Platform Telegram worker and webhook ingress

## Added Node entrypoints

- `npm run start:platform-webhook` accepts only `POST /telegram/platform/master` and `POST /telegram/platform/intake`, verifies a separate Telegram secret-token value for each identity, and atomically enqueues the update through `enqueuePlatformBotUpdate`.
- `npm run start:platform-worker` claims only `telegram.master.update` and `telegram.intake.update` jobs. It constructs the existing master and intake bot handlers in webhook mode and never starts long polling.
- Customer-bot updates remain on the existing `telegram.update` worker path and customer inbox.

## Required environment

Copy `.env.platform.example` to a private local environment file and populate it with staging-only values. Do not commit the populated file. The worker requires the existing PostgreSQL URL, 32-byte hex encryption key, master bot token, administrator Telegram ID, and intake bot token. The ingress requires the database URL and two independent URL-safe webhook secrets (32-256 characters).

Set Telegram's `secret_token` for the master bot to `MASTER_WEBHOOK_SECRET` and for the intake bot to `INTAKE_WEBHOOK_SECRET`. Keep those values separate from bot tokens. Configure each Telegram webhook URL to its matching route only after both staging services are deployed and tested.

## Isolation and deployment boundary

- Master and intake updates use distinct queue job types and a separate platform-bot inbox.
- The platform worker registers no customer `telegram.update` handler.
- The webhook ingress never receives or logs bot tokens.
- The ingress and worker are separate processes/services; the worker must have no public ingress.
- Start with a disposable PostgreSQL database and staging Telegram bots. Do not point these processes at production or call Telegram `setWebhook` until the full staging acceptance test is complete.
- This wiring does not deploy services, change Telegram webhook configuration, migrate production data, or alter production secrets.

## Verification still required

Run the unit and PostgreSQL integration workflows on the new branch, then test separate staging master/intake bots end-to-end, including duplicate delivery, retry, lease expiry, and clean shutdown. A green CI run is not proof that a live webhook or production deployment is active.
