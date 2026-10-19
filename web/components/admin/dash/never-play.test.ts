// "Never play" on the Dash's now-playing track: what the operator is told
// after the confirm dialog. The block is the existing POST /library/blocklist
// (absolute, requests included); the skip is the existing POST /dj/skip and is
// the operator's choice in the dialog.
//
// Run: npm test -- never-play

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neverPlayToast } from './never-play';

const T = { title: 'Blindspot', artist: 'Bomb the Bass' };

test('blocked and left to finish', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'not-asked' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · it finishes now',
  });
});

test('blocked and skipped', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'done' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · skipped',
  });
});

test('queued copies dropped by the purge are counted', () => {
  assert.equal(
    neverPlayToast({ ...T, block: 'added', skip: 'done', purged: 2 }).text,
    '“Blindspot” — Bomb the Bass will never air again · skipped · 2 dropped from queue',
  );
});

test('already on the list is not an error, and the skip still happens', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'already', skip: 'done' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass was already on the never-play list · skipped',
  });
});

// The block landed; only the skip failed. That must read as a partial
// success, never as "nothing happened", or the operator retries a block.
test('a failed skip after a block is a warning naming what did land', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'failed', skipError: 'liquidsoap telnet down' }), {
    tone: 'err',
    text: '“Blindspot” — Bomb the Bass will never air again · skip failed: liquidsoap telnet down',
  });
});

test('no artist: the title alone', () => {
  assert.equal(
    neverPlayToast({ title: 'Untitled', block: 'added', skip: 'not-asked' }).text,
    '“Untitled” will never air again · it finishes now',
  );
});
