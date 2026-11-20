'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'telegram-master.js'),
  'utf8'
);

test('deployment readiness review callback is restricted to the configured admin', () => {
  const start = source.indexOf(String.raw`bot.callbackQuery(/^project:deploy:readiness:(\d+)$/,`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);
  assert.ok(handler.indexOf('if (!isAdmin(ctx))') < handler.indexOf('getReleaseCandidate('));
  assert.ok(handler.includes('project_deployment_authorizations'));
  assert.ok(handler.includes('reviewDeploymentReadiness({ release, authorization })'));
});

test('deployment authorization reply exposes the read-only readiness review action', () => {
  const start = source.indexOf(String.raw`bot.callbackQuery(/^project:deploy-auth:authorize:(\d+)$/,`);
  const end = source.indexOf('\n});', start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes('project:deploy:readiness:'));
  assert.ok(handler.includes('مراجعة متطلبات الجاهزية'));
});
