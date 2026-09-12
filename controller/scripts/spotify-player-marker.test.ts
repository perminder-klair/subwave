// The Spotify-mode marker parsers (broadcast/spotify-player-pure.ts) and their
// IO shell: every malformed input is null, ids are validated, the audio state's
// Liquidsoap seconds become ms, and the shell reads a real file with a memo.
//
// Run: npm test -- spotify-player-marker

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-spotify-marker-'));
process.env.STATE_DIR = stateRoot;

const { parseSpotifyPlayerEvent, parseSpotifyAudioState } = await import('../src/broadcast/spotify-player-pure.js');
const markers = await import('../src/broadcast/spotify-player.js');

test('a well-formed event parses; junk in any field is dropped, not guessed', () => {
  const ok = parseSpotifyPlayerEvent({ event: 'track_changed', trackId: 'AAAAAAAAAAAAAAAAAAAAAA', uri: 'spotify:track:A', positionMs: 0, durationMs: 200000, at: 1700000000000 });
  // `seq` is the event-feed cursor; absent from a marker-only event, and null
  // rather than missing so a reader never has to tell the two apart.
  assert.deepEqual(ok, { event: 'track_changed', trackId: 'AAAAAAAAAAAAAAAAAAAAAA', positionMs: 0, durationMs: 200000, at: 1700000000000, seq: null });
  assert.equal(parseSpotifyPlayerEvent({ event: 'playing', trackId: 'AAAAAAAAAAAAAAAAAAAAAA', at: 1700000000000, seq: 7 })!.seq, 7, 'a real cursor survives');
  assert.equal(parseSpotifyPlayerEvent(null), null);
  assert.equal(parseSpotifyPlayerEvent({ event: '', at: 1 }), null);
  assert.equal(parseSpotifyPlayerEvent({ event: 'playing', at: 0 }), null, 'a marker with no clock is unusable');
  assert.equal(parseSpotifyPlayerEvent({ event: 'rm -rf', at: 1 }), null, 'event names are [a-z_]');
  const badId = parseSpotifyPlayerEvent({ event: 'playing', trackId: 'not-an-id', positionMs: -5, at: 1700000000000 })!;
  assert.equal(badId.trackId, null);
  assert.equal(badId.positionMs, null, 'negative positions read as unknown');
});

test('the audio state converts Liquidsoap seconds to ms and refuses other states', () => {
  assert.deepEqual(parseSpotifyAudioState({ state: 'silent', at: 1700000000.5 }), { state: 'silent', atMs: 1700000000500 });
  assert.equal(parseSpotifyAudioState({ state: 'loud', at: 1 }), null);
  assert.equal(parseSpotifyAudioState('silent'), null);
});

test('the IO shell reads the marker files, returns null when absent, and memoises briefly', () => {
  let now = 1_700_000_000_000;
  assert.equal(markers.currentSpotifyPlayerEvent(now), null, 'absent before the first event');
  writeFileSync(markers.SPOTIFY_PLAYER_FILE, JSON.stringify({ event: 'playing', trackId: 'AAAAAAAAAAAAAAAAAAAAAA', positionMs: 1000, durationMs: 200000, at: now }));
  assert.equal(markers.currentSpotifyPlayerEvent(now), null, 'still the memoised null within 250ms');
  now += 300;
  assert.equal(markers.currentSpotifyPlayerEvent(now)?.event, 'playing');
  writeFileSync(markers.SPOTIFY_PLAYER_FILE, '{ torn');
  now += 300;
  assert.equal(markers.currentSpotifyPlayerEvent(now), null, 'a torn file is null, never a throw');
  writeFileSync(markers.SPOTIFY_AUDIO_FILE, JSON.stringify({ state: 'audio', at: 1700000000 }));
  assert.equal(markers.currentSpotifyAudioState(now)?.state, 'audio');
});
