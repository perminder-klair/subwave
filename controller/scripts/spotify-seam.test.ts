// The Spotify transport's pure decisions (music/sources/spotify/seam-pure.ts):
// folding librespot events into a current-track model, the seam clock, the
// idle/paused/never-started fallbacks, the mismatch policy and the metadata
// handed to the mixer. No player, no mixer, no wall clock.
//
// Run: npm test -- spotify-seam

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEvent, remainingMs, positionNow, seamDecision, mismatchAction, mixerMetadataFor,
  type CurrentTrack,
} from '../src/music/sources/spotify/seam-pure.js';

const T0 = 1_700_000_000_000;
const ev = (event: string, over: Partial<{ trackId: string | null; positionMs: number | null; durationMs: number | null; at: number }> = {}) => ({
  event, trackId: null, positionMs: null, durationMs: null, at: T0, ...over,
});
const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';

test('track_changed starts a track; playing/seeked/paused move its clock', () => {
  let { current, meaning } = applyEvent(null, ev('track_changed', { trackId: ID_A, durationMs: 200_000 }));
  assert.deepEqual(meaning, { kind: 'started', trackId: ID_A });
  assert.equal(current!.id, ID_A);
  assert.equal(current!.playing, true);
  assert.equal(remainingMs(current, T0 + 10_000), 190_000, 'extrapolated from the start');

  ({ current, meaning } = applyEvent(current, ev('seeked', { trackId: ID_A, positionMs: 150_000, at: T0 + 12_000 })));
  assert.equal(meaning.kind, 'progress');
  assert.equal(remainingMs(current, T0 + 12_000), 50_000);

  ({ current } = applyEvent(current, ev('paused', { trackId: ID_A, positionMs: 160_000, at: T0 + 22_000 })));
  assert.equal(current!.playing, false);
  assert.equal(positionNow(current!, T0 + 60_000), 160_000, 'a paused clock does not advance');

  ({ current, meaning } = applyEvent(current, ev('end_of_track', { trackId: ID_A, at: T0 + 70_000 })));
  assert.equal(meaning.kind, 'ended');
  assert.equal(current!.ended, true);
  assert.equal(remainingMs(current, T0 + 70_000), 0);
});

test('a position for a track never seen starting is adopted (controller restart mid-song)', () => {
  const { current, meaning } = applyEvent(null, ev('playing', { trackId: ID_B, positionMs: 30_000, at: T0 }));
  assert.deepEqual(meaning, { kind: 'started', trackId: ID_B });
  assert.equal(current!.durationMs, null, 'duration unknown until the catalog is asked');
  assert.equal(remainingMs(current, T0), null);
});

test('unavailable / session events are reported, unknown events ignored', () => {
  assert.equal(applyEvent(null, ev('unavailable', { trackId: ID_A })).meaning.kind, 'unavailable');
  assert.deepEqual(applyEvent(null, ev('session_connected')).meaning, { kind: 'session', connected: true });
  assert.deepEqual(applyEvent(null, ev('session_disconnected')).meaning, { kind: 'session', connected: false });
  assert.equal(applyEvent(null, ev('volume_changed')).meaning.kind, 'ignore');
  assert.equal(applyEvent(null, ev('track_changed', { trackId: null })).meaning.kind, 'ignore', 'a track_changed without an id is noise');
});

const cur = (over: Partial<CurrentTrack> = {}): CurrentTrack => ({
  id: ID_A, durationMs: 200_000, positionMs: 0, positionAt: T0, playing: true, ended: false, ...over,
});
const base = { seamLeadMs: 1500, startTimeoutMs: 12_000, idleMs: 15_000, lastCommandAt: null, awaitingStart: false, commandedAt: null };

test('the seam fires seamLeadMs before the end, with or without a pick (fallback)', () => {
  assert.equal(seamDecision({ ...base, now: T0 + 100_000, current: cur(), hasPending: true }).action, 'hold');
  const d = seamDecision({ ...base, now: T0 + 198_600, current: cur(), hasPending: true });
  assert.equal(d.action, 'command-next');
  const f = seamDecision({ ...base, now: T0 + 198_600, current: cur(), hasPending: false });
  assert.equal(f.action, 'command-next');
  assert.match(f.reason, /fallback/);
});

test('an ended track commands the next immediately; a playing one with unknown duration holds', () => {
  assert.equal(seamDecision({ ...base, now: T0, current: cur({ ended: true, playing: false }), hasPending: true }).action, 'command-next');
  assert.equal(seamDecision({ ...base, now: T0, current: cur({ durationMs: null }), hasPending: true }).action, 'hold');
});

test('awaiting a start holds until the start timeout, then reports the timeout', () => {
  assert.equal(seamDecision({ ...base, now: T0 + 5_000, current: null, hasPending: true, awaitingStart: true, commandedAt: T0 }).action, 'hold');
  assert.equal(seamDecision({ ...base, now: T0 + 13_000, current: null, hasPending: true, awaitingStart: true, commandedAt: T0 }).action, 'command-timeout');
});

test('nothing playing: a fresh boot waits idleMs for the player, then starts something', () => {
  assert.equal(seamDecision({ ...base, now: T0, current: null, hasPending: false, lastCommandAt: T0 - 1000 }).action, 'hold');
  assert.equal(seamDecision({ ...base, now: T0, current: null, hasPending: false, lastCommandAt: T0 - 20_000 }).action, 'command-next');
  assert.equal(seamDecision({ ...base, now: T0, current: null, hasPending: true, lastCommandAt: null }).action, 'command-next', 'never commanded anything → go');
  assert.equal(seamDecision({ ...base, now: T0, current: null, hasPending: false, lastCommandAt: null, idleMs: 0 }).action, 'command-next');
});

test('a paused feed is respected for idleMs, then treated as dead air', () => {
  const paused = cur({ playing: false, positionMs: 50_000, positionAt: T0 });
  assert.equal(seamDecision({ ...base, now: T0 + 5_000, current: paused, hasPending: true }).action, 'hold');
  assert.equal(seamDecision({ ...base, now: T0 + 16_000, current: paused, hasPending: true }).action, 'command-next');
});

test('mismatch: reclaim once, then adopt; follow adopts immediately', () => {
  assert.equal(mismatchAction('reclaim', 0), 'reclaim');
  assert.equal(mismatchAction('reclaim', 1), 'adopt');
  assert.equal(mismatchAction('follow', 0), 'adopt');
});

test('mixer metadata carries the annotate: keys, withholds a compilation year, joins genres', () => {
  const m = mixerMetadataFor({ id: ID_A, title: 'Glory Box', artist: 'Portishead', album: 'Dummy', year: 1994, genres: ['trip hop', 'downtempo'] });
  assert.deepEqual(m, { title: 'Glory Box', artist: 'Portishead', album: 'Dummy', subsonic_id: ID_A, year: '1994', genre: 'trip hop, downtempo' });
  const c = mixerMetadataFor({ id: ID_B, title: 'Hit', year: 2012, albumIsCompilation: true });
  assert.equal(c.year, undefined, 'a compilation year is the reissue date — omitted, not asserted (#1418)');
  assert.equal(c.artist, '');
  assert.equal(c.subsonic_id, ID_B);
});
