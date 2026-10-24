// The pure half of the shared lyrics hook (components/skins/lyrics.ts): which
// line is being sung, how the two timing corrections combine, and how long the
// panel waits before asking a station that did not answer.
//
// Run: `npm test -- lyrics`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LYRIC_OFFSET_MAX_MS,
  LYRIC_OFFSET_MIN_MS,
  activeLyricLineIndex,
  clampLyricOffsetMs,
  formatLyricOffset,
  lyricsRetryDelayMs,
} from './lyrics';
import type { PublicLyricsPayload } from '@/lib/schemas.generated';

const synced: PublicLyricsPayload = {
  songId: 's',
  synced: true,
  offsetMs: 0,
  lines: [
    { startMs: 2250, text: 'one' },
    { startMs: 5750, text: 'two' },
    { startMs: 9000, text: 'three' },
  ],
};

test('the active line is the last one whose start has passed', () => {
  assert.equal(activeLyricLineIndex(synced, 0, 0), -1, 'nothing before the first line');
  assert.equal(activeLyricLineIndex(synced, 2250, 0), 0);
  assert.equal(activeLyricLineIndex(synced, 5749, 0), 0);
  assert.equal(activeLyricLineIndex(synced, 6000, 0), 1);
  assert.equal(activeLyricLineIndex(synced, 600_000, 0), 2, 'the last line holds to the end');
});

test('a positive correction advances the highlighting, a negative one delays it', () => {
  assert.equal(activeLyricLineIndex(synced, 5000, 1000), 1);
  assert.equal(activeLyricLineIndex(synced, 6000, -1000), 0);
  // The station's offset and this device's nudge are one sum on the clock.
  assert.equal(activeLyricLineIndex(synced, 4000, 1000 + 800), 1);
  assert.equal(activeLyricLineIndex(synced, 1000, -5000), -1, 'never before the track started');
});

test('unsynced or absent lyrics have no active line', () => {
  assert.equal(activeLyricLineIndex(null, 5000, 0), -1);
  assert.equal(activeLyricLineIndex({ ...synced, synced: false }, 5000, 0), -1);
  const plain: PublicLyricsPayload = { ...synced, lines: [{ startMs: null, text: 'a' }, { startMs: 3000, text: 'b' }] };
  assert.equal(activeLyricLineIndex(plain, 4000, 0), 1, 'an untimed line is skipped, not treated as zero');
});

test('offsets clamp to the shared bounds and round to whole milliseconds', () => {
  assert.equal(LYRIC_OFFSET_MIN_MS, -30_000);
  assert.equal(LYRIC_OFFSET_MAX_MS, 30_000);
  assert.equal(clampLyricOffsetMs(45_000), 30_000);
  assert.equal(clampLyricOffsetMs(-45_000), -30_000);
  assert.equal(clampLyricOffsetMs(1234.6), 1235);
  assert.equal(clampLyricOffsetMs(Number.NaN), 0);
  assert.equal(formatLyricOffset(0), '0.00s');
  assert.equal(formatLyricOffset(2900), '+2.90s');
  assert.equal(formatLyricOffset(-400), '-0.40s');
});

test('retries back off to a minute and never come sooner than Retry-After', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(n => lyricsRetryDelayMs(n, null)), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  assert.equal(lyricsRetryDelayMs(0, 10), 10_000, 'the station asked for ten seconds');
  assert.equal(lyricsRetryDelayMs(2, 10), 20_000, 'the backoff is already longer');
  assert.equal(lyricsRetryDelayMs(0, 3600), 60_000, 'a huge Retry-After still re-asks within a minute');
});
