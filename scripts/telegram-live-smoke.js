'use strict';

const DEFAULT_MESSAGE = 'BOSS BOT PLATFORM: اختبار اتصال تجريبي ناجح. هذه رسالة فحص آلية ويمكن تجاهلها.';

async function telegramApiCall(token, method, payload, fetchImpl) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });

  let body;
  try {
    body = await response.json();
  } catch (_) {
    throw new Error('Telegram API returned a non-JSON response.');
  }

  if (!response.ok || body?.ok !== true) {
    const description = typeof body?.description === 'string'
      ? body.description.slice(0, 300)
      : 'Unknown Telegram API error';
    throw new Error(`Telegram API ${method} failed (HTTP ${response.status}): ${description}`);
  }
  return body.result;
}

async function runTelegramLiveSmoke({
  token,
  chatId,
  fetchImpl = globalThis.fetch
}) {
  if (typeof token !== 'string' || !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error('BOSS_TEST_TELEGRAM_BOT_TOKEN is missing or has an invalid format.');
  }
  if ((typeof chatId !== 'string' && typeof chatId !== 'number') ||
      !/^-?\d{1,20}$/.test(String(chatId))) {
    throw new Error('BOSS_TEST_TELEGRAM_CHAT_ID is missing or invalid.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch implementation is required.');

  const bot = await telegramApiCall(token, 'getMe', {}, fetchImpl);
  if (bot.is_bot !== true || !Number.isSafeInteger(bot.id)) {
    throw new Error('Telegram getMe did not return a valid bot identity.');
  }

  const message = await telegramApiCall(token, 'sendMessage', {
    chat_id: String(chatId),
    text: DEFAULT_MESSAGE,
    disable_notification: true
  }, fetchImpl);

  if (!Number.isSafeInteger(message.message_id) ||
      String(message.chat?.id) !== String(chatId)) {
    throw new Error('Telegram sendMessage response did not match the configured test chat.');
  }

  return {
    ok: true,
    botUsername: bot.username || null,
    botId: bot.id,
    chatId: String(message.chat.id),
    messageId: message.message_id
  };
}

async function main() {
  const result = await runTelegramLiveSmoke({
    token: process.env.BOSS_TEST_TELEGRAM_BOT_TOKEN,
    chatId: process.env.BOSS_TEST_TELEGRAM_CHAT_ID
  });
  console.log(JSON.stringify({
    ok: result.ok,
    botUsername: result.botUsername,
    botId: result.botId,
    chatId: result.chatId,
    messageId: result.messageId
  }));
}

if (require.main === module) {
  main().catch(error => {
    console.error('TELEGRAM LIVE SMOKE FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { runTelegramLiveSmoke };
