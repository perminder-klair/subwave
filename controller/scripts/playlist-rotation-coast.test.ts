// The auto.m3u coast for a strict-playlist show (#1919) — music/show-recency.ts
// rotationCoast/coastFloor, the queue's air-time reader, and their wiring in
// broadcast/scheduler.ts.
//
// THE DEFECT. With `llm.pauseWhenEmpty` the DJ stops picking whenever nobody is
// listening and the station coasts on auto.m3u, which the refresh cron rebuilds
// at most an hour apart. For a strict-playlist show each build filtered the
// playlist through the station-wide trackHours recency window; on a show that
// airs most of the day that left 2-5 tracks, and the source's never-starve only
// fires on ZERO. One reported hour aired one track six times and another five.
//
// Run: npm test -- playlist-rotation-coast

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coastFloor, COAST_MIN_SEC, rotationCoast, rotationOrder, type AirTimeOf } from '../src/music/show-recency.js';
import { createPoolBuilder } from '../src/broadcast/auto-pool.js';
import { queue } from '../src/broadcast/queue.js';

type Track = { id: string; title: string; artist: string; duration?: number };

// duration 0 = unknown length.
const makeTracks = (n: number, duration = 240): Track[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `Track ${i + 1}`,
    artist: `Artist ${i + 1}`,
    ...(duration ? { duration } : {}),
  }));

// t1 aired longest ago, the last track is on air.
const airedInOrder = (tracks: Track[]): AirTimeOf => {
  const at = new Map(tracks.map((t, i) => [t.id, i + 1]));
  const onAir = tracks.at(-1)!.id;
  return (t) => (t.id === onAir ? Infinity : at.get(t.id!) ?? null);
};

const ids = (tracks: { id?: string }[]) => tracks.map((t) => t.id);
const seconds = (tracks: { duration?: number }[]) => tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);

// ── the rotation's coast ─────────────────────────────────────────────────────

test('a full rotation coasts on its longest-waiting tracks, not a recency sample', () => {
  // The reported 109-track rotation. Liquidsoap shuffles the file, so the SET
  // is what carries the rotation: the 32 most overdue, a strict playlist's
  // usual share, nothing from the half the listener heard most recently.
  const tracks = makeTracks(109);
  const coast = rotationCoast(tracks, airedInOrder(tracks), { cap: 32 });
  assert.deepEqual(ids(coast), ids(tracks.slice(0, 32)));
  assert.ok(seconds(coast) >= COAST_MIN_SEC, 'over an hour of audio');
});

test('never-aired tracks are the most overdue of all', () => {
  const tracks = makeTracks(109);
  const aired = airedInOrder(tracks);
  const fresh = new Set(['t50', 't80']);
  const coast = rotationCoast(tracks, (t) => (fresh.has(t.id!) ? null : aired(t)), { cap: 32 });
  assert.deepEqual(ids(coast.slice(0, 2)), ['t50', 't80']);
  assert.equal(coast.length, 32);
});

test('the hour floor reaches past the half when the half is short', () => {
  // 30 tracks of 200s: the due half is 15 tracks, 50 minutes. Three more of
  // the next-due make the hour.
  const tracks = makeTracks(30, 200);
  const coast = rotationCoast(tracks, airedInOrder(tracks), { cap: 32 });
  assert.deepEqual(ids(coast), ids(tracks.slice(0, 18)));
  assert.equal(seconds(coast), COAST_MIN_SEC);
});

test('a rotation shorter than the floor coasts on all of it but the track on air', () => {
  const tracks = makeTracks(10);
  const coast = rotationCoast(tracks, airedInOrder(tracks), { cap: 32 });
  assert.deepEqual(ids(coast), ids(tracks.slice(0, 9)), 'nothing is left out, and the on-air track is not let back in');
});

test('an unknown length counts as nothing, so the file runs longer, never shorter', () => {
  const tracks = makeTracks(40, 0);
  const coast = rotationCoast(tracks, airedInOrder(tracks), { cap: 32 });
  assert.equal(coast.length, 39, 'cannot prove the hour, so everything not on air');
});

test('what is on air or queued is the last resort, never dropped to nothing', () => {
  const tracks = makeTracks(2);
  assert.deepEqual(ids(rotationCoast(tracks, () => Infinity, { cap: 32 })), ['t1', 't2']);
});

test('one row per audible identity', () => {
  const tracks = [...makeTracks(6), { id: 't1-rip', title: 'Track 1', artist: 'Artist 1', duration: 240 }];
  const coast = rotationCoast(tracks, airedInOrder(makeTracks(6)), { cap: 32, floorSec: 0 });
  assert.equal(coast.filter((t) => t.title === 'Track 1').length, 1);
});

test('rotationOrder is longest-waiting first and stable on ties', () => {
  const tracks = makeTracks(5);
  const at: Record<string, number | null> = { t1: 30, t2: null, t3: Infinity, t4: 10, t5: null };
  assert.deepEqual(ids(rotationOrder(tracks, (t) => at[t.id!])), ['t2', 't5', 't4', 't1', 't3']);
});

// ── the floor under every strict-playlist coast ──────────────────────────────

test('the reported collapse is topped up to an hour with the longest-waiting tracks', () => {
  // A non-rotating strict playlist whose recency-filtered take kept 3 tracks.
  const tracks = makeTracks(109);
  const aired = airedInOrder(tracks);
  const collapsed = [tracks[60], tracks[61], tracks[0]];
  const filled = coastFloor(collapsed, rotationOrder(tracks, aired), aired);
  assert.deepEqual(ids(filled.slice(0, 3)), ids(collapsed), 'what the sources chose stays');
  assert.deepEqual(ids(filled.slice(3)), ids(tracks.slice(1, 13)), 'then the most overdue, skipping what is already in');
  assert.ok(seconds(filled) >= COAST_MIN_SEC);
});

test('a coast already over the floor is returned as a copy, never as itself', () => {
  // scheduler's replacePool clears the pool before refilling it, so a filter
  // that hands its input back empties the coast (music.md, never-starve).
  const tracks = makeTracks(20);
  const pool = tracks.slice(0, 16);
  const kept = coastFloor(pool, tracks, airedInOrder(tracks));
  assert.notEqual(kept, pool);
  assert.deepEqual(ids(kept), ids(pool));
  const empty: Track[] = [];
  assert.notEqual(coastFloor(empty, [], () => null), empty);
});

test('the floor never adds the track on air or a queued one while anything else exists', () => {
  const tracks = makeTracks(20);
  const aired = airedInOrder(tracks);
  const filled = coastFloor([], rotationOrder(tracks, aired), aired);
  assert.ok(!ids(filled).includes('t20'));
  assert.equal(filled.length, 15, '15 x 240s is the hour');
});

// ── the pool builder lets a rotation skip the station's recency window ────────

test('ignoreRecency keeps a source the trackHours window would have emptied', () => {
  const tracks = makeTracks(3);
  const recentIds = new Set(tracks.map((t) => t.id));
  const b = createPoolBuilder({ recentIds, recentKeys: new Set(), targetPool: 40, maxPerArtist: 2 });
  b.take('show-rotation', tracks, 3, { ignoreRecency: true });
  assert.equal(b.pool.length, 3);
  b.take('mood', makeTracks(5).slice(3), 5);
  assert.equal(b.pool.length, 5, 'other sources keep their recency guard');
  const c = createPoolBuilder({ recentIds, recentKeys: new Set(), targetPool: 40, maxPerArtist: 2 });
  c.take('show-playlist', [...tracks, { id: 'fresh', title: 'Fresh', artist: 'X' }], 4, { neverStarve: true });
  assert.deepEqual(ids(c.pool), ['fresh'], 'without it the window still applies');
});

// ── the queue's air-time reader ──────────────────────────────────────────────

test('queue.rotationAirTimes reads the sidecar, and counts on-air and queued tracks as spent', () => {
  // No library is loaded here, so this pins the in-process half; the durable
  // plays index sits underneath it on a live station.
  const q = queue as any;
  const saved = { current: q.current, upcoming: q.upcoming, plays: q._recentPlays };
  try {
    q._recentPlays = [
      { id: 'a', title: 'A', artist: 'X', endedAt: '2026-10-16T10:00:00.000Z' },
      { id: null, title: 'B', artist: 'Y', endedAt: '2026-10-16T09:00:00.000Z' },
      { id: 'a', title: 'A', artist: 'X', endedAt: '2026-10-15T10:00:00.000Z' },
    ];
    q.current = { track: { id: 'on', title: 'On Air', artist: 'Z' } };
    q.upcoming = [{ track: { id: 'next', title: 'Next', artist: 'Z' } }];
    const at = queue.rotationAirTimes();
    assert.equal(at({ id: 'a', title: 'A', artist: 'X' }), Date.parse('2026-10-16T10:00:00.000Z'), 'newest airing wins');
    assert.equal(at({ id: 'b-rip', title: 'b ', artist: 'y' }), Date.parse('2026-10-16T09:00:00.000Z'),
      'an id-less row still dates its title|artist');
    assert.equal(at({ id: 'on' }), Infinity, 'on air');
    assert.equal(at({ id: 'next' }), Infinity, 'queued');
    assert.equal(at({ id: 'never', title: 'Never', artist: 'W' }), null, 'never aired');
  } finally {
    q.current = saved.current;
    q.upcoming = saved.upcoming;
    q._recentPlays = saved.plays;
  }
});

// ── the wiring ───────────────────────────────────────────────────────────────

const scheduler = readFileSync(new URL('../src/broadcast/scheduler.ts', import.meta.url), 'utf8');
const build = scheduler.slice(scheduler.indexOf('async function refreshAutoPlaylistInner'));

test('the coast asks the pickers\' guard whether this show rotates', () => {
  // One decision: a second reading of "is this a full rotation" here is how the
  // coast and the pickers would come to disagree about the same show.
  assert.match(build, /showNoRepeatGuard\([\s\S]{0,400}\}\)\.rotation/);
  assert.match(build, /else if \(rotationPool\) take\('show-rotation', rotationPool, rotationPool\.length, \{ ignoreRecency: true/,
    'the rotation replaces the sampled sources, after an episode and without the trackHours window');
});

test('every strict playlist gets the floor, from the airable anchor, before the length ceiling', () => {
  const floorAt = build.indexOf('coastFloor(');
  const ceilingAt = build.indexOf('replacePool(applyKnownTrackCeiling(pool, selectionMaxSec))');
  const excludedAt = build.indexOf('if (excludedIds) {');
  assert.ok(floorAt > excludedAt && floorAt < ceilingAt, 'after the end filters, before the ceiling and the write');
  assert.match(build, /if \(strictPlaylist && !episodeSource\) \{\s*const airable = rotation \?\? airableAnchorTracks\(/,
    'the same "can this anchor track air" rule the pickers count');
});
