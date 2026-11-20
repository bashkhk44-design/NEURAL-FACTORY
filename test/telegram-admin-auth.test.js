'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateAdmin } = require('../telegram-admin-auth');

test('allows the configured administrator in a private chat', () => {
  assert.equal(isPrivateAdmin({
    from: { id: 12345 },
    chat: { type: 'private' }
  }, '12345'), true);
});

test('rejects the administrator in groups and supergroups', () => {
  for (const type of ['group', 'supergroup']) {
    assert.equal(isPrivateAdmin({
      from: { id: 12345 },
      chat: { type }
    }, '12345'), false);
  }
});

test('rejects other users and contexts without a private chat', () => {
  assert.equal(isPrivateAdmin({
    from: { id: 999 },
    chat: { type: 'private' }
  }, '12345'), false);
  assert.equal(isPrivateAdmin({ from: { id: 12345 } }, '12345'), false);
  assert.equal(isPrivateAdmin({ chat: { type: 'private' } }, '12345'), false);
  assert.equal(isPrivateAdmin({
    from: { id: 12345 },
    chat: { type: 'private' }
  }, undefined), false);
});
