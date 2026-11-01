import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skinLocked } from './skinLock';

test('a public station never locks its skin, though its phase stays at checking for good', () => {
  assert.equal(skinLocked(false, 'checking'), false);
  assert.equal(skinLocked(false, 'ok'), false);
});

test('a stored password being checked locks the skin until the station answers', () => {
  assert.equal(skinLocked(true, 'checking'), true);
});

test('the prompt locks the skin, even once the lock is lifted beneath it', () => {
  assert.equal(skinLocked(true, 'prompt'), true);
  assert.equal(skinLocked(false, 'prompt'), true);
});

test('an accepted password releases the skin', () => {
  assert.equal(skinLocked(true, 'ok'), false);
});
