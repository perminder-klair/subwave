// Album / block queueing — the pure plan (#1622 FR 4).
//
// Three things have to hold, and the first is the whole feature:
//
//   1. An ALBUM keeps its own running order. A shuffled album is not a
//      degraded album block, it is twelve tracks by one artist — which the
//      operator could already queue one at a time.
//   2. The never-play blocklist is NOT bypassed. A block is an explicit
//      operator action and gets every exemption `POST /dj/queue-track` already
//      has, but the blocklist is absolute with no never-starve anywhere, and
//      a blocked track is skipped and NAMED rather than silently dropped.
//   3. The cap TRUNCATES and reports. Refusing a double album over its length
//      is the wrong answer to an explicit action; dropping six tracks without
//      saying so is worse than either.
//
// The route's own wiring — the two exemptions actually passed to push(), the
// block stamp, the cancel — is pinned separately in queue-block-wiring.test.ts.
//
// Run: npm test -- queue-block

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blockLabel,
  blockPlayableSec,
  orderAlbumTracks,
  planBlock,
  shuffleTracks,
  type BlockSong,
} from '../src/broadcast/block-queue.js';
import { QUEUE_BLOCK_MAX_TRACKS } from '../src/schemas/dj.js';

const song = (over: Partial<BlockSong> & { id?: string | null }): BlockSong => ({
  id: 't', title: 'T', artist: 'A', album: 'Rec', ...over,
});
const never = () => null;
const titles = (list: readonly BlockSong[]) => list.map(s => s.title);

// ── the running order ──────────────────────────────────────────────────────

test('an album sorts by disc then track, whatever order the server sent', () => {
  const sent = [
    song({ id: '4', title: 'D2T2', discNumber: 2, track: 2 }),
    song({ id: '2', title: 'D1T2', discNumber: 1, track: 2 }),
    song({ id: '3', title: 'D2T1', discNumber: 2, track: 1 }),
    song({ id: '1', title: 'D1T1', discNumber: 1, track: 1 }),
  ];
  assert.deepEqual(titles(orderAlbumTracks(sent)), ['D1T1', 'D1T2', 'D2T1', 'D2T2']);
});

// A single-disc release omits the field to mean disc 1, so reading it as
// anything else would sort every untagged track away from its own record.
test('a missing disc number reads as disc 1', () => {
  const sent = [
    song({ id: '2', title: 'D2T1', discNumber: 2, track: 1 }),
    song({ id: '1', title: 'T3', track: 3 }),
    song({ id: '0', title: 'T1', track: 1 }),
  ];
  assert.deepEqual(titles(orderAlbumTracks(sent)), ['T1', 'T3', 'D2T1']);
});

// An untagged bonus cut appended to a tagged record is far commoner than an
// untagged opener, so an absent track number sorts to the END of its disc.
test('a missing track number sorts last on its disc, not first', () => {
  const sent = [
    song({ id: '9', title: 'Untagged' }),
    song({ id: '2', title: 'Two', track: 2 }),
    song({ id: '1', title: 'One', track: 1 }),
  ];
  assert.deepEqual(titles(orderAlbumTracks(sent)), ['One', 'Two', 'Untagged']);
});

// A release that tags neither must come back exactly as the server sent it,
// rather than being re-arranged into a sort's incidental order.
test('with nothing tagged, the source order survives', () => {
  const sent = [
    song({ id: 'c', title: 'C' }),
    song({ id: 'a', title: 'A' }),
    song({ id: 'b', title: 'B' }),
  ];
  assert.deepEqual(titles(orderAlbumTracks(sent)), ['C', 'A', 'B']);
});

test('planBlock imposes the album order even when asked for natural', () => {
  const plan = planBlock({
    kind: 'album',
    songs: [song({ id: '2', title: 'Two', track: 2 }), song({ id: '1', title: 'One', track: 1 })],
    order: 'natural',
    hitOf: never,
  });
  assert.deepEqual(titles(plan.tracks), ['One', 'Two']);
});

// The schema refuses order:'shuffle' on an album, so this can only be reached
// by a caller going around it — and the plan still will not shuffle a record.
// Belt over braces: this is the one property the whole feature rests on.
test('an album is never shuffled, even if shuffle somehow reaches the plan', () => {
  const songs = [
    song({ id: '1', title: 'One', track: 1 }),
    song({ id: '2', title: 'Two', track: 2 }),
    song({ id: '3', title: 'Three', track: 3 }),
  ];
  const plan = planBlock({
    kind: 'album', songs, order: 'shuffle', hitOf: never,
    rand: () => 0, // would reverse-ish any list it actually touched
  });
  assert.deepEqual(titles(plan.tracks), ['One', 'Two', 'Three']);
});

// ── the artist block ───────────────────────────────────────────────────────

test('an artist block keeps the source ranking under natural order', () => {
  const songs = [song({ id: 'a', title: 'Hit' }), song({ id: 'b', title: 'Deep cut' })];
  const plan = planBlock({ kind: 'artist', songs, order: 'natural', hitOf: never });
  assert.deepEqual(titles(plan.tracks), ['Hit', 'Deep cut']);
});

test('an artist block shuffles when asked, deterministically under an injected rand', () => {
  const songs = [1, 2, 3, 4, 5].map(n => song({ id: String(n), title: String(n) }));
  const plan = planBlock({ kind: 'artist', songs, order: 'shuffle', hitOf: never, rand: () => 0 });
  // The permutation itself is not the contract — that the SET survives is.
  assert.equal(plan.tracks.length, 5);
  assert.deepEqual([...titles(plan.tracks)].sort(), ['1', '2', '3', '4', '5']);
});

test('shuffleTracks leaves its input alone', () => {
  const input = [1, 2, 3];
  const out = shuffleTracks(input, () => 0);
  assert.deepEqual(input, [1, 2, 3]);
  assert.notEqual(out, input);
});

test("an artist block's limit binds", () => {
  const songs = [1, 2, 3, 4, 5].map(n => song({ id: String(n), title: String(n) }));
  const plan = planBlock({ kind: 'artist', songs, order: 'natural', limit: 3, hitOf: never });
  assert.deepEqual(titles(plan.tracks), ['1', '2', '3']);
  assert.equal(plan.truncated, 2);
});

test('a limit is ignored on an album — a record is queued whole', () => {
  const songs = [1, 2, 3, 4].map(n => song({ id: String(n), title: String(n), track: n }));
  const plan = planBlock({ kind: 'album', songs, order: 'natural', limit: 2, hitOf: never });
  assert.equal(plan.tracks.length, 4);
  assert.equal(plan.truncated, 0);
});

// ── the blocklist, which is not bypassed ───────────────────────────────────

test('a blocked track is skipped and named, and the rest of the record queues', () => {
  const songs = [
    song({ id: '1', title: 'One', track: 1 }),
    song({ id: '2', title: 'Two', track: 2 }),
    song({ id: '3', title: 'Three', track: 3 }),
  ];
  const ref = { kind: 'rule', label: 'no covers' };
  const plan = planBlock({
    kind: 'album', songs, order: 'natural',
    hitOf: (s) => (s.id === '2' ? ref : null),
  });
  assert.deepEqual(titles(plan.tracks), ['One', 'Three']);
  assert.equal(plan.skipped.length, 1);
  assert.deepEqual(plan.skipped[0], { title: 'Two', artist: 'A', reason: 'blocked', blockedBy: ref });
});

// A record with two blocked cuts must still queue its full remaining length.
// Capping first would take two MORE off the end to make room for tracks that
// were never going to air.
test('blocked tracks are removed before the cap, not counted against it', () => {
  const songs = Array.from({ length: QUEUE_BLOCK_MAX_TRACKS + 2 }, (_, i) =>
    song({ id: String(i), title: String(i), track: i + 1 }));
  const plan = planBlock({
    kind: 'album', songs, order: 'natural',
    hitOf: (s) => (s.id === '0' || s.id === '1' ? { kind: 'entry' } : null),
  });
  assert.equal(plan.tracks.length, QUEUE_BLOCK_MAX_TRACKS);
  assert.equal(plan.skipped.length, 2);
  assert.equal(plan.truncated, 0, 'the two blocked cuts made room rather than costing two more');
  assert.equal(plan.tracks[0].title, '2', 'and the survivors keep the record order');
});

test('a track with no id is unplayable, named, and does not take a slot', () => {
  const plan = planBlock({
    kind: 'album',
    songs: [song({ id: null, title: 'Ghost', track: 1 }), song({ id: '2', title: 'Real', track: 2 })],
    order: 'natural',
    hitOf: never,
  });
  assert.deepEqual(titles(plan.tracks), ['Real']);
  assert.deepEqual(plan.skipped, [{ title: 'Ghost', artist: 'A', reason: 'unplayable', blockedBy: null }]);
});

// ── the cap ────────────────────────────────────────────────────────────────

test('a longer record is truncated from the tail and the truncation is reported', () => {
  const songs = Array.from({ length: QUEUE_BLOCK_MAX_TRACKS + 5 }, (_, i) =>
    song({ id: String(i), title: String(i), track: i + 1 }));
  const plan = planBlock({ kind: 'album', songs, order: 'natural', hitOf: never });
  assert.equal(plan.tracks.length, QUEUE_BLOCK_MAX_TRACKS);
  assert.equal(plan.truncated, 5);
  assert.equal(plan.tracks[0].title, '0', 'the record is cut at the END, never the front');
});

// ── the label, and the span the show-change warning is measured from ───────

test('the label names the record and who made it, the artist just themselves', () => {
  assert.equal(blockLabel({ kind: 'album', name: 'Immunity', artist: 'Jon Hopkins' }), 'Immunity — Jon Hopkins');
  assert.equal(blockLabel({ kind: 'album', name: 'Immunity' }), 'Immunity');
  assert.equal(blockLabel({ kind: 'artist', artist: 'Jon Hopkins' }), 'Jon Hopkins');
  assert.equal(blockLabel({ kind: 'album' }), 'Unknown album');
});

test('the block span is the sum of the playable spans', () => {
  const tracks = [song({ id: '1' }), song({ id: '2' })];
  assert.equal(blockPlayableSec(tracks, () => 120), 240);
});

// Null, never a partial total: a short answer would under-state the overrun,
// which is the direction that reads as "this fits" when it does not.
test('one unmeasured track makes the whole span unknown', () => {
  const tracks = [song({ id: '1' }), song({ id: '2' })];
  assert.equal(blockPlayableSec(tracks, (s) => (s.id === '2' ? null : 120)), null);
  assert.equal(blockPlayableSec(tracks, (s) => (s.id === '2' ? 0 : 120)), null);
});
