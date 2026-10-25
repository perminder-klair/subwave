import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeLyricLineIndex,
  clampLyricOffsetMs,
  formatLyricOffset,
  lyricFocusLine,
  lyricMoment,
  lyricsNote,
  lyricsResultFor,
  lyricsRetryDelayMs,
  parseLyricsPayload,
  pendingRecheckDelayMs,
  PENDING_MAX_ASKS,
  LINE_HOLD_MS,
  TEASE_MS,
} from '../src/lib/lyrics.ts';
import type { PublicLyricsPayload } from '../src/lib/types.ts';

const SYNCED: PublicLyricsPayload = {
  songId: 'abc',
  synced: true,
  offsetMs: 0,
  lines: [
    { startMs: 10_000, text: 'First line here' },
    { startMs: 14_000, text: 'Second line' },
    { startMs: 40_000, text: 'After the break' },
  ],
  source: 'music-server',
  pending: false,
};

test('a well-formed payload parses, and an unknown source reads as null rather than failing', () => {
  assert.deepEqual(parseLyricsPayload(SYNCED), SYNCED);
  const parsed = parseLyricsPayload({ ...SYNCED, source: 'some-future-source' });
  assert.equal(parsed?.source, null);
  assert.equal(parsed?.lines.length, 3);
});

test('a station from before the LRCLIB fallback omits source and pending', () => {
  const { source: _s, pending: _p, ...old } = SYNCED;
  const parsed = parseLyricsPayload(old);
  assert.ok(parsed);
  assert.equal('source' in parsed, false);
  assert.equal('pending' in parsed, false);
});

test('a malformed payload is not lyrics', () => {
  assert.equal(parseLyricsPayload(null), null);
  assert.equal(parseLyricsPayload([]), null);
  assert.equal(parseLyricsPayload({ ...SYNCED, songId: undefined }), null);
  assert.equal(parseLyricsPayload({ ...SYNCED, synced: 'yes' }), null);
  assert.equal(parseLyricsPayload({ ...SYNCED, offsetMs: '0' }), null);
  assert.equal(parseLyricsPayload({ ...SYNCED, pending: 'no' }), null);
  assert.equal(parseLyricsPayload({ ...SYNCED, lines: [{ startMs: '1', text: 'x' }] }), null);
  assert.equal(parseLyricsPayload({ ...SYNCED, lines: [{ startMs: 1 }] }), null);
});

test('untimed lines carry a null start', () => {
  const parsed = parseLyricsPayload({ songId: 'x', synced: false, offsetMs: 0, lines: [{ startMs: null, text: 'la' }] });
  assert.deepEqual(parsed?.lines, [{ startMs: null, text: 'la' }]);
});

test('each response status maps to the result the hook acts on', () => {
  assert.deepEqual(lyricsResultFor(403, null, undefined), { kind: 'disabled' });
  assert.deepEqual(lyricsResultFor(409, null, undefined), { kind: 'gone' });
  assert.deepEqual(lyricsResultFor(401, null, undefined), { kind: 'locked' });
  assert.deepEqual(lyricsResultFor(503, '30', undefined), { kind: 'unavailable', retryAfterSec: 30 });
  assert.deepEqual(lyricsResultFor(429, 'soon', undefined), { kind: 'unavailable', retryAfterSec: null });
  assert.deepEqual(lyricsResultFor(200, null, SYNCED), { kind: 'ok', payload: SYNCED });
  // A 200 that is not a payload is the station not answering, never "no lyrics".
  assert.deepEqual(lyricsResultFor(200, null, undefined), { kind: 'unavailable', retryAfterSec: null });
});

test('the active line is the last one started; before the first there is none', () => {
  assert.equal(activeLyricLineIndex(SYNCED, 0), -1);
  assert.equal(activeLyricLineIndex(SYNCED, 10_000), 0);
  assert.equal(activeLyricLineIndex(SYNCED, 15_000), 1);
  assert.equal(activeLyricLineIndex(SYNCED, 60_000), 2);
  assert.equal(activeLyricLineIndex({ ...SYNCED, synced: false }, 15_000), -1);
});

test('an intro rests and teases the first line only close to it', () => {
  const far = lyricMoment(SYNCED, 10_000 - TEASE_MS - 1);
  assert.deepEqual(far, { current: -1, progress: 0, next: -1, resting: true });
  const near = lyricMoment(SYNCED, 10_000 - TEASE_MS);
  assert.equal(near.next, 0);
  assert.equal(near.resting, true);
  // The column centres the line to come while nothing is sung.
  assert.equal(lyricFocusLine(SYNCED, near, 10_000 - TEASE_MS), 0);
});

test('a line is sung word by word, and a long gap after it is a break', () => {
  const start = lyricMoment(SYNCED, 10_000);
  assert.equal(start.current, 0);
  assert.equal(start.progress, 0);
  assert.equal(start.next, 1);
  // Three words at 380ms each: done after 1140ms.
  assert.equal(lyricMoment(SYNCED, 11_140).progress, 1);
  const held = lyricMoment(SYNCED, 14_000 + LINE_HOLD_MS + 1);
  assert.equal(held.current, -1);
  assert.equal(held.resting, true);
  assert.equal(lyricFocusLine(SYNCED, held, 14_000 + LINE_HOLD_MS + 1), 2);
});

test('after the last line the focus stays on it', () => {
  const outro = lyricMoment(SYNCED, 40_000 + LINE_HOLD_MS + 1);
  assert.equal(outro.current, -1);
  assert.equal(lyricFocusLine(SYNCED, outro, 40_000 + LINE_HOLD_MS + 1), 2);
});

test('offsets clamp to the station bounds and print signed', () => {
  assert.equal(clampLyricOffsetMs(45_000), 30_000);
  assert.equal(clampLyricOffsetMs(-45_000), -30_000);
  assert.equal(clampLyricOffsetMs(Number.NaN), 0);
  assert.equal(clampLyricOffsetMs(149.6), 150);
  assert.equal(formatLyricOffset(0), '0.00s');
  assert.equal(formatLyricOffset(250), '+0.25s');
  assert.equal(formatLyricOffset(-1500), '-1.50s');
});

test('retries back off to a minute and never come sooner than Retry-After', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((a) => lyricsRetryDelayMs(a, null)), [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(lyricsRetryDelayMs(0, 30), 30_000);
  assert.equal(lyricsRetryDelayMs(0, 600), 60_000);
});

test('a pending answer is asked about again a bounded number of times', () => {
  assert.equal(pendingRecheckDelayMs(0), 4000);
  assert.equal(pendingRecheckDelayMs(PENDING_MAX_ASKS - 1), 4000);
  assert.equal(pendingRecheckDelayMs(PENDING_MAX_ASKS), null);
});

test('the settings line says what the track has, or why nothing', () => {
  const ready = (lyrics: PublicLyricsPayload) => ({ status: 'ready' as const, lyrics });
  assert.equal(lyricsNote(ready(SYNCED), false), 'Hidden on this device.');
  assert.equal(lyricsNote(ready(SYNCED), true), 'Synced lyrics, from the station’s library.');
  assert.equal(lyricsNote(ready({ ...SYNCED, source: 'lrclib' }), true), 'Synced lyrics, from LRCLIB.');
  const plain = { ...SYNCED, synced: false, lines: [{ startMs: null, text: 'la' }] };
  assert.equal(lyricsNote(ready({ ...plain, pending: true }), true), 'Untimed for now, still looking for synced ones.');
  assert.equal(lyricsNote(ready({ ...SYNCED, lines: [], pending: true }), true), 'Looking for lyrics…');
  assert.equal(lyricsNote({ status: 'unavailable', lyrics: null }, true), 'The station isn’t answering. Trying again…');
  assert.equal(lyricsNote({ status: 'gone', lyrics: null }, true), 'No lyrics for this song.');
});
