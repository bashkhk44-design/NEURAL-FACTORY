# Telegram live smoke test

This is a manually triggered connectivity check. It does not deploy the platform, alter the database, enable webhooks, or start customer-bot workers.

## What it verifies

1. Telegram accepts the dedicated test bot token through `getMe`.
2. Telegram accepts one quiet test message to the configured test chat through `sendMessage`.
3. The returned chat ID matches the configured destination.

The test message is: "BOSS BOT PLATFORM: اختبار اتصال تجريبي ناجح. هذه رسالة فحص آلية ويمكن تجاهلها."

This test does **not** prove inbound updates, the PostgreSQL worker lease, or an end-to-end customer bot reply. Those require a separate isolated staging test.

## Required GitHub Actions secrets

Create these repository Actions secrets using a dedicated test bot and a private test chat:

- `BOSS_TEST_TELEGRAM_BOT_TOKEN`: token for the dedicated test bot only.
- `BOSS_TEST_TELEGRAM_CHAT_ID`: numeric ID of the private test chat.

Never paste either value into a commit, issue, chat message, workflow input, or log. Do not use a production bot token or a public/customer chat.

GitHub settings page:
https://github.com/bashkhk44-design/BOSS-WHATSAPP-BOT/settings/secrets/actions

## Manual run

1. Open the Actions tab.
2. Select **Telegram Live Smoke Test**.
3. Press **Run workflow**.
4. Check the confirmation box only when you are ready to receive one test message.
5. Start the workflow and inspect its result.

If the confirmation box is not selected, the job is intentionally skipped.

## Safety

- The workflow is manual-only and sends exactly one message.
- It uses a read-only repository permission.
- It does not print or upload the token.
- It does not connect to PostgreSQL or modify any production service.
- Keep this workflow pointed only at a dedicated test bot and private test chat.
