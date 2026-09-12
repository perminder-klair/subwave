// The refused-track memory (unplayable-file.ts) and the same-recording matcher
// (alternative-pure.ts).
//
// What these assertions stand for: Spotify's February 2026 API gives the station
// NO way to know a track is unplayable before it tries. Measured on a real run,
// one unavailable track was picked, commanded and refused 212 times in a row —
// an LLM call and a play command each — because the failure was logged and then
// forgotten. So the store is the brake, and everything here is about it braking
// without also deleting music the operator still has.
//
// Run: npm test -- spotify-unplayable

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { beforeEach } from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-unplayable-'));
process.env.STATE_DIR = stateRoot;

const store = await import('../src/music/sources/spotify/unplayable-file.js');
const { rankAlternatives, trackTitleKey, performanceMarkers, DURATION_TOLERANCE_SEC } =
  await import('../src/music/sources/spotify/alternative-pure.js');

const { UNPLAYABLE_TTL_MS, UNPLAYABLE_MAX } = store;

let seq = 0;
let file = '';
beforeEach(() => {
  seq++;
  file = path.join(stateRoot, `unplayable-${seq}.json`);
  store.resetUnplayableCache(file);
});

// writeFileAtomic is async and fire-and-forget inside markUnplayable, so a test
// that reads the FILE (rather than the cache) has to let the microtask run.
const settled = () => new Promise((r) => setTimeout(r, 20));

const song = (over: Record<string, unknown> = {}) => ({
  id: 'a'.repeat(22), title: 'Hurricane', artist: 'Bob Dylan', duration: 513, albumId: 'alb1',
  ...over,
} as any);

// ── the store ───────────────────────────────────────────────────────────────

test('a refusal is remembered, persisted and read back', async () => {
  store.markUnplayable('t1', { title: 'Hurricane', artist: 'Bob Dylan', reason: 'unavailable' });
  assert.equal(store.isKnownUnplayable('t1'), true);
  assert.equal(store.unplayableCount(), 1);
  await settled();

  assert.equal(existsSync(file), true, 'the refusal reached disk');
  const fresh = store.readUnplayable(file);
  assert.equal(fresh.get('t1')?.title, 'Hurricane');
  assert.equal(fresh.get('t1')?.hits, 1);
});

test('a repeat bumps hits and lastAt but NOT `at` — a hammered track cannot postpone its own expiry', () => {
  const t0 = 1_700_000_000_000;
  store.markUnplayable('t1', { title: 'Hurricane' }, t0);
  const second = store.markUnplayable('t1', { title: 'Hurricane' }, t0 + 60_000);
  assert.equal(second.hits, 2);
  assert.equal(second.at, t0, 'the expiry clock still starts at the FIRST refusal');
  assert.equal(second.lastAt, t0 + 60_000);

  // …and that is what makes the expiry reachable at all: still refused every
  // minute, it is forgotten on schedule rather than never.
  assert.equal(store.isKnownUnplayable('t1', t0 + UNPLAYABLE_TTL_MS + 1), false);
});

test('an entry past the TTL is gone — from isKnownUnplayable, the id set and the count', () => {
  const t0 = 1_700_000_000_000;
  store.markUnplayable('old', {}, t0);
  store.markUnplayable('new', {}, t0 + UNPLAYABLE_TTL_MS - 1000);

  const later = t0 + UNPLAYABLE_TTL_MS + 1;
  assert.equal(store.isKnownUnplayable('old', later), false);
  assert.equal(store.isKnownUnplayable('new', later), true);
  assert.deepEqual([...store.unplayableIds(later)], ['new']);
  assert.equal(store.unplayableCount(later), 1);
});

test('readUnplayable drops expired rows and survives junk', () => {
  const t0 = 1_700_000_000_000;
  writeFileSync(file, JSON.stringify({
    live: { at: t0, lastAt: t0, hits: 1, title: 'A', artist: 'B', reason: 'unavailable' },
    expired: { at: t0 - UNPLAYABLE_TTL_MS - 1, hits: 3 },
    junk: 'not an object',
    noAt: { hits: 2 },
  }));
  const map = store.readUnplayable(file, t0);
  assert.deepEqual([...map.keys()], ['live']);

  // A file that cannot be parsed is an empty map, never a throw — the same
  // position the code was in before the store existed.
  writeFileSync(file, '{ not json');
  assert.equal(store.readUnplayable(file, t0).size, 0);
});

test('the store is bounded — oldest refusals evicted past the cap', () => {
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < UNPLAYABLE_MAX + 5; i++) store.markUnplayable(`t${i}`, {}, t0 + i);
  const ids = store.unplayableIds(t0 + UNPLAYABLE_MAX + 10);
  assert.equal(ids.size, UNPLAYABLE_MAX);
  assert.equal(ids.has('t0'), false, 'the oldest went first');
  assert.equal(ids.has(`t${UNPLAYABLE_MAX + 4}`), true, 'the newest stayed');
});

test('clear forgets everything and removes the file', async () => {
  store.markUnplayable('t1', {});
  store.markUnplayable('t2', {});
  await settled();
  assert.equal(store.clearUnplayable(), 2);
  assert.equal(store.unplayableCount(), 0);
  assert.equal(existsSync(file), false);
});

test('the admin list is newest-refusal-first', () => {
  const t0 = 1_700_000_000_000;
  store.markUnplayable('old', { title: 'Old' }, t0);
  store.markUnplayable('mid', { title: 'Mid' }, t0 + 1000);
  store.markUnplayable('new', { title: 'New' }, t0 + 2000);
  assert.deepEqual(store.unplayableList(2, t0 + 3000).map((r) => r.id), ['new', 'mid']);
});

// ── the matcher ─────────────────────────────────────────────────────────────

test('edition noise folds away; a different cut does not', () => {
  assert.equal(trackTitleKey('Hurricane - 2018 Remaster'), 'hurricane');
  assert.equal(trackTitleKey('Hurricane (Remastered)'), 'hurricane');
  assert.equal(trackTitleKey('Hurricane - Mono'), 'hurricane');
  assert.equal(trackTitleKey('Hurricane (Deluxe Edition)'), 'hurricane');
  // A cut of a different LENGTH is a different recording and must keep its name.
  assert.notEqual(trackTitleKey('Black Magic Woman - Single Version'), trackTitleKey('Black Magic Woman'));
  assert.equal(performanceMarkers('Black Magic Woman - Single Version').has('single version'), true);
  assert.equal(performanceMarkers('Hurricane (Live at Budokan)').has('live'), true);
  assert.equal(performanceMarkers('Olive Branch').has('live'), false, 'word boundaries, not substrings');
});

test('a remaster on another album is accepted and preferred over the same album', () => {
  const want = song();
  const { ranked } = rankAlternatives(want, [
    song({ id: 'b'.repeat(22), title: 'Hurricane - 2018 Remaster', duration: 515, albumId: 'alb2' }),
    song({ id: 'c'.repeat(22), title: 'Hurricane', duration: 513, albumId: 'alb1' }),
  ]);
  assert.deepEqual(ranked.map((s) => s.id), ['b'.repeat(22), 'c'.repeat(22)],
    'the other release wins the tie-break against the album that just failed');
});

test('a different performance is refused however well the rest matches', () => {
  const want = song();
  const { ranked, notes } = rankAlternatives(want, [
    song({ id: 'b'.repeat(22), title: 'Hurricane - Live', duration: 515 }),
    song({ id: 'c'.repeat(22), title: 'Hurricane (Karaoke Version)', duration: 513 }),
    song({ id: 'd'.repeat(22), title: 'Hurricane - 2004 Remix', duration: 513 }),
  ]);
  assert.deepEqual(ranked, [], 'live, karaoke and remix are other recordings');
  assert.deepEqual(notes.map((n) => n.rejected), ['adds "live"', 'adds "karaoke"', 'adds "remix"']);
});

test('the wrong artist, the same id and a known-bad id are all refused', () => {
  const want = song();
  const known = new Set(['e'.repeat(22)]);
  const { notes } = rankAlternatives(want, [
    song({ id: 'b'.repeat(22), artist: 'The Hurricanes' }),
    song({ id: want.id }),
    song({ id: 'e'.repeat(22) }),
  ], known);
  assert.deepEqual(notes.map((n) => n.rejected),
    ['different artist', 'same track', 'already known unplayable']);
});

test('duration is the tie-break, and past the tolerance it is a rejection', () => {
  const want = song({ duration: 300 });
  const { ranked, notes } = rankAlternatives(want, [
    song({ id: 'b'.repeat(22), duration: 320, albumId: 'alb2' }),   // 20s → out
    song({ id: 'c'.repeat(22), duration: 310, albumId: 'alb3' }),   // 10s → in
    song({ id: 'd'.repeat(22), duration: 302, albumId: 'alb4' }),   // 2s  → in, best
  ]);
  assert.equal(notes[0].rejected, `${20}s from the original`);
  assert.ok(DURATION_TOLERANCE_SEC < 20 && DURATION_TOLERANCE_SEC >= 10);
  assert.deepEqual(ranked.map((s) => s.id), ['d'.repeat(22), 'c'.repeat(22)]);
});

test('a measurable duration outranks an unknown one', () => {
  const want = song({ duration: 300 });
  const { ranked } = rankAlternatives(want, [
    song({ id: 'b'.repeat(22), duration: undefined, albumId: 'alb2' }),
    song({ id: 'c'.repeat(22), duration: 305, albumId: 'alb3' }),
  ]);
  assert.deepEqual(ranked.map((s) => s.id), ['c'.repeat(22), 'b'.repeat(22)]);
});
