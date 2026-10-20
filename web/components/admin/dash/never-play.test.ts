// "Never play" on the Dash's now-playing track: what the operator is told
// after the confirm dialog. The block is the existing POST /library/blocklist
// (absolute, requests included); the skip is the existing POST /dj/skip and is
// the operator's choice in the dialog.
//
// Run: npm test -- never-play

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockPlayingTrack, neverPlayToast, skipDecision } from './never-play';

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

// The track can change while the block request is in flight (a slow
// Navidrome getSong has no upper bound). The skip is decided on a FRESH
// read taken after the block lands, never on the status the click saw.
test('skip decision: still on air after the block, so skip', () => {
  assert.equal(skipDecision({ skipToo: true, targetId: 'a', onAirId: 'a' }), 'skip');
});

test('skip decision: the track changed during the block, so nothing is skipped', () => {
  assert.equal(skipDecision({ skipToo: true, targetId: 'a', onAirId: 'b' }), 'moot');
});

test('skip decision: an unknown on-air track is never skipped', () => {
  assert.equal(skipDecision({ skipToo: true, targetId: 'a', onAirId: undefined }), 'moot');
  assert.equal(skipDecision({ skipToo: true, targetId: 'a', onAirId: null }), 'moot');
});

test('skip decision: "let it finish" never skips, whatever is on air', () => {
  assert.equal(skipDecision({ skipToo: false, targetId: 'a', onAirId: 'a' }), 'not-asked');
  assert.equal(skipDecision({ skipToo: false, targetId: 'a', onAirId: 'b' }), 'not-asked');
});

test('a skip asked for but moot says so, rather than "it finishes now"', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'moot' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · no longer on air, nothing skipped',
  });
});

// The controller contract the block relies on: 201 { entry, purged } on a
// new entry, 409 on a duplicate, anything else is a failure.
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetcher };
}

test('block: 201 carries the entry and the purge count, posted as a track block', async () => {
  const entry = { type: 'track', id: 'a', name: 'Blindspot' };
  const s = stubFetch(201, { entry, purged: 2 });
  assert.deepEqual(await blockPlayingTrack(s.fetcher, 'a'), { block: 'added', purged: 2, entry });
  const [call] = s.calls;
  assert.ok(call);
  assert.equal(call.path, '/library/blocklist');
  assert.equal(call.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(call.init?.body)), { type: 'track', trackId: 'a' });
});

test('block: 409 already blocked is an outcome, not an error', async () => {
  const s = stubFetch(409, { error: 'already blocked' });
  assert.deepEqual(await blockPlayingTrack(s.fetcher, 'a'), { block: 'already' });
});

test('block: any other failure throws, so nothing is skipped', async () => {
  const s = stubFetch(500, { error: 'boom' });
  await assert.rejects(() => blockPlayingTrack(s.fetcher, 'a'));
});
