'use strict';

const { Bot } = require('grammy');

function registerCustomerBotHandlers(clientBot, record) {
  clientBot.command('start', async (ctx) => {
    await ctx.reply(
      'أهلاً بك في ' + record.name + ' 👋\n\n' +
      'هذا بوت النشاط، وسيتم إعداد خدماته قريباً.'
    );
  });

  clientBot.command('help', async (ctx) => {
    await ctx.reply(
      'مساعدة ' + record.name + '\n\n' +
      'سيتم تفعيل خدمات هذا البوت بعد إعداد مواصفاته.'
    );
  });

  clientBot.catch((err) => {
    console.error(
      'CUSTOMER BOT ' + record.id + ' UPDATE ERROR:',
      err.error_code || '',
      err.message || ''
    );
  });

  return clientBot;
}

// Single source of truth for both polling and durable-queue transports.
function createCustomerBot(record, token) {
  const clientBot = new Bot(token, { client: { timeoutSeconds: 45 } });
  return registerCustomerBotHandlers(clientBot, record);
}

module.exports = { createCustomerBot, registerCustomerBotHandlers };
