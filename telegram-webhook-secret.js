'use strict';

const crypto = require('node:crypto');

function deriveTelegramWebhookSecret(botId, token, encryptionKey) {
  const numericId = Number(botId);
  if (!Number.isSafeInteger(numericId) || numericId < 1) throw new TypeError('A valid botId is required');
  if (typeof token !== 'string' || !token.trim()) throw new TypeError('A bot token is required');
  const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : Buffer.from(String(encryptionKey || ''), 'hex');
  if (key.length !== 32) throw new TypeError('A 32-byte encryption key is required');

  return crypto.createHmac('sha256', key)
    .update('BOSS-BOT-MASTER-TELEGRAM-WEBHOOK-V1:')
    .update(String(numericId))
    .update(':')
    .update(token)
    .digest('hex');
}

module.exports = { deriveTelegramWebhookSecret };
