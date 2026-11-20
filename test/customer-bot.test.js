'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerCustomerBotHandlers } = require('../customer-bot');

test('shared customer bot factory preserves polling /start and /help replies', async () => {
  const handlers = new Map();
  let errorHandler;
  const bot = {
    command(name, handler) {
      handlers.set(name, handler);
      return this;
    },
    catch(handler) {
      errorHandler = handler;
      return this;
    }
  };
  const replies = [];

  registerCustomerBotHandlers(bot, { id: 17, name: 'Test Activity' });

  assert.equal(typeof errorHandler, 'function');
  assert.equal(handlers.size, 2);

  await handlers.get('start')({
    reply: async text => replies.push(text)
  });
  await handlers.get('help')({
    reply: async text => replies.push(text)
  });

  assert.equal(replies.length, 2);
  assert.match(replies[0], /أهلاً بك في Test Activity/);
  assert.match(replies[0], /سيتم إعداد خدماته قريباً/);
  assert.match(replies[1], /مساعدة Test Activity/);
  assert.match(replies[1], /سيتم تفعيل خدمات هذا البوت/);
});
