'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runTelegramLiveSmoke } = require('../scripts/telegram-live-smoke');

test('Telegram live smoke validates bot identity and confirms delivery to the configured chat', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/getMe')) {
      return { ok: true, status: 200, async json() {
        return { ok: true, result: { id: 12345, is_bot: true, username: 'boss_test_bot' } };
      } };
    }
    return { ok: true, status: 200, async json() {
      return { ok: true, result: { message_id: 77, chat: { id: 987654 } } };
    } };
  };

  const result = await runTelegramLiveSmoke({
    token: '12345:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
    chatId: '987654',
    fetchImpl
  });

  assert.deepEqual(result, {
    ok: true,
    botUsername: 'boss_test_bot',
    botId: 12345,
    chatId: '987654',
    messageId: 77
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/getMe'));
  assert.ok(calls[1].url.endsWith('/sendMessage'));
  assert.match(calls[1].options.body, /اختبار اتصال تجريبي ناجح/);
  assert.equal(calls[1].options.signal instanceof AbortSignal, true);
});

test('Telegram live smoke rejects missing or malformed credentials before making a request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('should not call network'); };

  await assert.rejects(
    runTelegramLiveSmoke({ token: '', chatId: '123', fetchImpl }),
    /TOKEN is missing or has an invalid format/
  );
  await assert.rejects(
    runTelegramLiveSmoke({
      token: '12345:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
      chatId: 'bad-chat',
      fetchImpl
    }),
    /CHAT_ID is missing or invalid/
  );
  assert.equal(calls, 0);
});

test('Telegram live smoke fails if Telegram rejects the configured destination', async () => {
  const fetchImpl = async url => ({
    ok: true,
    status: 200,
    async json() {
      return url.endsWith('/getMe')
        ? { ok: true, result: { id: 12345, is_bot: true, username: 'boss_test_bot' } }
        : { ok: false, description: 'Forbidden: bot was blocked by the user' };
    }
  });

  await assert.rejects(
    runTelegramLiveSmoke({
      token: '12345:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
      chatId: '987654',
      fetchImpl
    }),
    /sendMessage failed.*Forbidden/
  );
});
