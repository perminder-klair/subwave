// Personal listener scrobbling (#2015): browser heartbeats prove listening,
// while the controller owns audible-track resolution, elapsed time and
// cross-tab deduplication.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PersonalScrobbleTracker,
  personalAiringAt,
  type PersonalAiring,
} from '../src/broadcast/personal-scrobble.js';

const base = Date.parse('2026-10-20T12:00:00.000Z');

function airing(overrides: Partial<PersonalAiring> = {}): PersonalAiring {
  return {
    key: 'song-1\u00002026-10-20T12:00:00.000Z',
    track: { id: 'song-1', title: 'One', artist: 'Artist', duration: 40 },
    startedAtMs: base,
    ...overrides,
  };
}

test('personal tracker counts confirmed playback and submits once', () => {
  const playing: string[] = [];
  const submitted: string[] = [];
  const tracker = new PersonalScrobbleTracker({
    onNowPlaying: track => playing.push(String(track.title)),
    onSubmit: track => submitted.push(String(track.title)),
  });
  const a = airing();

  tracker.report({ playbackId: 'browser_1', playing: true, airing: a, nowMs: base });
  let result = tracker.report({ playbackId: 'browser_1', playing: true, airing: a, nowMs: base + 10_000 });
  assert.equal(result.heardSeconds, 10);
  assert.deepEqual(submitted, []);

  result = tracker.report({ playbackId: 'browser_1', playing: true, airing: a, nowMs: base + 20_000 });
  assert.equal(result.heardSeconds, 20);
  assert.equal(result.submitted, true);
  assert.deepEqual(playing, ['One']);
  assert.deepEqual(submitted, ['One']);

  tracker.report({ playbackId: 'browser_1', playing: true, airing: a, nowMs: base + 30_000 });
  tracker.report({ playbackId: 'browser_1', playing: false, airing: null, nowMs: base + 31_000 });
  assert.deepEqual(submitted, ['One'], 'later heartbeats and stop cannot duplicate the submission');
});

test('overlapping tabs contribute the union of heard time', () => {
  const tracker = new PersonalScrobbleTracker({ onNowPlaying() {}, onSubmit() {} });
  const a = airing({ track: { title: 'Long', artist: 'Artist', duration: 200 } });

  tracker.report({ playbackId: 'browser_a', playing: true, airing: a, nowMs: base });
  tracker.report({ playbackId: 'browser_b', playing: true, airing: a, nowMs: base });
  tracker.report({ playbackId: 'browser_a', playing: true, airing: a, nowMs: base + 10_000 });
  const result = tracker.report({ playbackId: 'browser_b', playing: true, airing: a, nowMs: base + 10_000 });

  assert.equal(result.heardSeconds, 10, 'the same ten seconds from two tabs count once');
  assert.equal(result.submitted, false);
});

test('pause and stale heartbeat gaps do not invent listening time', () => {
  const tracker = new PersonalScrobbleTracker({ onNowPlaying() {}, onSubmit() {} });
  const a = airing({ track: { title: 'Long', artist: 'Artist', duration: 200 } });

  tracker.report({ playbackId: 'browser_a', playing: true, airing: a, nowMs: base });
  let result = tracker.report({ playbackId: 'browser_a', playing: false, airing: null, nowMs: base + 7_000 });
  assert.equal(result.heardSeconds, 7);

  tracker.report({ playbackId: 'browser_a', playing: true, airing: a, nowMs: base + 60_000 });
  result = tracker.report({ playbackId: 'browser_a', playing: true, airing: a, nowMs: base + 140_000 });
  assert.equal(result.heardSeconds, 7, 'a report outside the heartbeat window starts fresh');
});

test('track changes split one confirmed interval at the audible boundary', () => {
  const tracker = new PersonalScrobbleTracker({ onNowPlaying() {}, onSubmit() {} });
  const first = airing({ track: { title: 'First', artist: 'Artist', duration: 200 } });
  const second = airing({
    key: 'song-2\u00002026-10-20T12:00:08.000Z',
    track: { id: 'song-2', title: 'Second', artist: 'Artist', duration: 200 },
    startedAtMs: base + 8_000,
  });

  tracker.report({ playbackId: 'browser_a', playing: true, airing: first, nowMs: base });
  const result = tracker.report({ playbackId: 'browser_a', playing: true, airing: second, nowMs: base + 10_000 });
  assert.equal(result.heardSeconds, 2);
});

test('audible-track resolver applies stream delay and accepts recent history', () => {
  const current = {
    track: { id: 'new', title: 'New', artist: 'Artist', duration: 180 },
    startedAt: new Date(base + 20_000).toISOString(),
  };
  const previous = {
    track: { id: 'old', title: 'Old', artist: 'Artist', duration: 180 },
    startedAt: new Date(base - 160_000).toISOString(),
    endedAt: new Date(base + 20_000).toISOString(),
  };

  const heard = personalAiringAt(current, [previous], 22, base + 30_000);
  assert.equal(heard?.track.id, 'old');
  assert.equal(heard?.startedAtMs, base - 138_000);
});
