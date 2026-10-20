// "Never play" on the Dash's now-playing track: what the operator is told
// after the confirm dialog. The block is the existing POST /library/blocklist
// (absolute, requests included); the skip is the existing POST /dj/skip,
// targeted at the blocked track, and is the operator's choice in the dialog.
//
// Run: npm test -- never-play

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockPlayingTrack, freshOnAirId, neverPlayToast, skipDecision, skipFailureOutcome } from './never-play';
import { runDashAction } from './queries';

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
  assert.equal(skipDecision({ targetId: 'a', onAirId: 'a' }), 'skip');
});

test('skip decision: the track changed during the block, so nothing is skipped', () => {
  assert.equal(skipDecision({ targetId: 'a', onAirId: 'b' }), 'moot');
});

test('skip decision: no fresh on-air track is never skipped', () => {
  assert.equal(skipDecision({ targetId: 'a', onAirId: undefined }), 'unconfirmed');
});

const SINCE = 1_000;
const read = (dataUpdatedAt: number, id?: string | null) =>
  ({ dataUpdatedAt, data: { nowPlaying: id === null ? null : { subsonic_id: id } } });

test('fresh read: a status read that landed after the block names the track', () => {
  assert.equal(freshOnAirId(read(SINCE, 'a'), SINCE), 'a');
  assert.equal(freshOnAirId(read(SINCE + 50, 'b'), SINCE), 'b');
});

// refetchQueries swallows a failed fetch and returns at once while offline,
// leaving a poll taken before the block landed: the very read the guard
// refuses, so it must not decide a skip.
test('fresh read: a failed or offline refetch leaves no read at all', () => {
  assert.equal(freshOnAirId(read(SINCE - 1, 'a'), SINCE), undefined);
  assert.equal(freshOnAirId(undefined, SINCE), undefined);
  assert.equal(skipDecision({ targetId: 'a', onAirId: freshOnAirId(read(SINCE - 1, 'a'), SINCE) }), 'unconfirmed');
});

test('fresh read: one naming no track gives no id', () => {
  assert.equal(freshOnAirId(read(SINCE, null), SINCE), undefined);
  assert.equal(freshOnAirId(read(SINCE, undefined), SINCE), undefined);
  assert.equal(freshOnAirId({ dataUpdatedAt: SINCE }, SINCE), undefined);
});

test('a skip asked for but moot says so, rather than "it finishes now"', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'moot' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · no longer on air, nothing skipped',
  });
});

// No fresh read: the track may well still be on air, so "no longer on air"
// would be a guess.
test('a skip with no fresh read says it was not confirmed, not that the track left', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'unconfirmed' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · not confirmed on air, nothing skipped',
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

// The skip is TARGETED at the blocked track (#2017). The controller refuses
// with 409 when that track is no longer on air — it ended during the commit
// wait, or a jingle, bed or break followed it, which no status read can see —
// and the toast says so, rather than "skip failed" over a skip that was
// correctly withheld.
async function targetedSkip(status: number, body: unknown) {
  const s = stubFetch(status, body);
  try {
    await runDashAction(s.fetcher, '/dj/skip', { expectId: 'a' });
    return { outcome: 'done' as const, calls: s.calls };
  } catch (error) {
    return { outcome: skipFailureOutcome(error), error, calls: s.calls };
  }
}

test('targeted skip: the request names the blocked track', async () => {
  const r = await targetedSkip(200, { ok: true });
  assert.equal(r.outcome, 'done');
  const [call] = r.calls;
  assert.ok(call);
  assert.equal(call.path, '/dj/skip');
  assert.deepEqual(JSON.parse(String(call.init?.body)), { expectId: 'a' });
});

test('targeted skip: a 409 refusal is the moot toast, not a failure', async () => {
  const r = await targetedSkip(409, { error: 'a jingle is on air after that track — nothing skipped', reason: 'jingle-on-air', onAirId: 'a' });
  assert.equal(r.outcome, 'moot');
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: r.outcome }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · no longer on air, nothing skipped',
  });
});

test('targeted skip: any other error still reads as a failed skip, with its message', async () => {
  const r = await targetedSkip(500, { error: 'liquidsoap telnet timeout' });
  assert.equal(r.outcome, 'failed');
  assert.ok(r.error instanceof Error);
  assert.equal(r.error.message, 'liquidsoap telnet timeout', 'the message every dash toast showed before');
  assert.equal(skipFailureOutcome(new Error('network down')), 'failed');
});
