'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'telegram-master.js'),
  'utf8'
);

test('deployment authorization callback accepts numeric release IDs', () => {
  assert.ok(source.includes(String.raw`bot.callbackQuery(/^project:deploy-auth:authorize:(\d+)$/,`));
  assert.ok(!source.includes(String.raw`bot.callbackQuery(/^project:deploy-auth:authorize:(\\d+)$/,`));
});

test('deployment authorization callback is restricted to the configured admin', () => {
  const start = source.indexOf('bot.callbackQuery(/^project:deploy-auth:authorize');
  assert.notEqual(start, -1);
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);
  assert.ok(handler.indexOf('if (!isAdmin(ctx))') < handler.indexOf('authorizeDeployment('));
});

test('deployment authorization confirmation uses actual line breaks', () => {
  const start = source.indexOf('bot.callbackQuery(/^project:deploy-auth:authorize');
  const end = source.indexOf('\n});', start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes(String.raw`authorization.id + ' أصبح معتمداً.\n' +`));
  assert.ok(!handler.includes(String.raw`authorization.id + ' أصبح معتمداً.\\n' +`));
});
