'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeWorkerHandlers, resolveWorkerHandlersPath } = require('../worker');

const baseHandler = async () => {};
const extraHandler = async () => {};
const existing = { 'telegram.update': baseHandler };

test('accepts valid additional handlers from a direct export', () => {
  const result = mergeWorkerHandlers(existing, {
    'custom.task.run': extraHandler
  });

  assert.equal(result['telegram.update'], baseHandler);
  assert.equal(result['custom.task.run'], extraHandler);
  assert.equal(Object.hasOwn(existing, 'custom.task.run'), false);
});

test('accepts valid additional handlers from a handlers export', () => {
  const result = mergeWorkerHandlers(existing, {
    handlers: { 'custom.task.run': extraHandler }
  });

  assert.equal(result['custom.task.run'], extraHandler);
});

test('rejects attempts to replace an existing handler', () => {
  assert.throws(
    () => mergeWorkerHandlers(existing, {
      'telegram.update': extraHandler
    }),
    /cannot replace existing job type/
  );
});

test('rejects invalid job type names', () => {
  assert.throws(
    () => mergeWorkerHandlers(existing, {
      'INVALID TYPE': extraHandler
    }),
    /invalid job type/
  );
});

test('rejects non-function handler values', () => {
  assert.throws(
    () => mergeWorkerHandlers(existing, {
      'custom.task.run': 'not-a-function'
    }),
    /must be a function/
  );
});

test('rejects missing, invalid, and empty custom handler exports', () => {
  for (const value of [null, undefined, [], {}, { handlers: null }, { handlers: {} }]) {
    assert.throws(() => mergeWorkerHandlers(existing, value));
  }
});


test('resolves custom handlers only from the project worker-handlers directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-worker-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'worker-handlers');
  fs.mkdirSync(dir);
  const inside = path.join(dir, 'custom.js');
  const outside = path.join(root, 'outside.js');
  fs.writeFileSync(inside, 'module.exports = {};');
  fs.writeFileSync(outside, 'module.exports = {};');

  assert.equal(resolveWorkerHandlersPath('worker-handlers/custom.js', root), fs.realpathSync(inside));
  assert.throws(
    () => resolveWorkerHandlersPath(path.join(root, 'outside.js'), root),
    /must resolve inside worker-handlers/
  );
});

test('rejects handler symlinks pointing outside worker-handlers', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-worker-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'worker-handlers');
  fs.mkdirSync(dir);
  const outside = path.join(root, 'outside.js');
  fs.writeFileSync(outside, 'module.exports = {};');
  fs.symlinkSync(outside, path.join(dir, 'linked.js'));

  assert.throws(
    () => resolveWorkerHandlersPath('worker-handlers/linked.js', root),
    /must resolve inside worker-handlers/
  );
});

test('rejects non-JavaScript custom handler paths', () => {
  assert.throws(
    () => resolveWorkerHandlersPath('worker-handlers/custom.json'),
    /must use a .js file/
  );
});
