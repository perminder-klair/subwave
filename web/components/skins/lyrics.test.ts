// The pure half of the shared lyrics hooks (components/skins/lyrics.ts): which
// line is being sung, how the two timing corrections combine, how long the
// panel waits before asking a station that did not answer, or one still
// looking a track up on LRCLIB, and what the lyrics settings say a track has.
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
  pendingRecheckDelayMs,
  PENDING_MAX_ASKS,
  PENDING_RECHECK_MS,
  LINE_HOLD_MS,
  TEASE_MS,
  lyricMoment,
  lyricsNote,
  plainLyricsReady,
  syncedLyricsReady,
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

test('a pending answer is asked again a few times, then the panel settles', () => {
  for (let asks = 0; asks < PENDING_MAX_ASKS; asks++) {
    assert.equal(pendingRecheckDelayMs(asks), PENDING_RECHECK_MS);
  }
  assert.equal(pendingRecheckDelayMs(PENDING_MAX_ASKS), null);
  // Long enough to outlast a lookup whose first try LRCLIB refused (the station
  // retries 5s then 15s later), short enough to read as live.
  assert.ok(PENDING_RECHECK_MS * PENDING_MAX_ASKS >= 20_000);
  assert.ok(PENDING_RECHECK_MS * PENDING_MAX_ASKS <= 60_000);
});

// Three lines: a short one, a long one followed by a 20s instrumental break,
// and a last one.
const song: PublicLyricsPayload = {
  songId: 's',
  synced: true,
  offsetMs: 0,
  lines: [
    { startMs: 10_000, text: 'one two three' },
    { startMs: 13_000, text: 'a longer line of six words' },
    { startMs: 40_000, text: 'after the break' },
  ],
};

test('an intro rests, and the first line is teased just before it is sung', () => {
  assert.deepEqual(lyricMoment(song, 0), { current: -1, progress: 0, next: -1, resting: true });
  assert.equal(lyricMoment(song, 10_000 - TEASE_MS).next, 0);
});

test('a line lights word by word across its own pace, with the next one waiting', () => {
  const start = lyricMoment(song, 10_000);
  assert.equal(start.current, 0);
  assert.equal(start.next, 1);
  assert.equal(start.progress, 0);
  // Three words take about 1.1s, well inside the 3s before the next line.
  assert.ok(lyricMoment(song, 10_600).progress > 0.4 && lyricMoment(song, 10_600).progress < 0.6);
  assert.equal(lyricMoment(song, 12_000).progress, 1, 'sung through, held until the next line');
});

test('a long gap after a line is a break: the stage rests, then teases what follows', () => {
  assert.equal(lyricMoment(song, 13_000 + LINE_HOLD_MS - 1).current, 1, 'held while it might still be sung');
  const brk = lyricMoment(song, 13_000 + LINE_HOLD_MS + 1);
  assert.equal(brk.current, -1);
  assert.equal(brk.resting, true);
  assert.equal(brk.next, -1, 'the next line is still far off');
  assert.equal(lyricMoment(song, 40_000 - TEASE_MS).next, 2);
  assert.equal(lyricMoment(song, 40_000).current, 2);
});

test('the last line is held, then the outro rests with nothing to tease', () => {
  assert.equal(lyricMoment(song, 41_000).next, -1);
  assert.deepEqual(lyricMoment(song, 40_000 + LINE_HOLD_MS + 1), { current: -1, progress: 0, next: -1, resting: true });
});

test('untimed or absent lyrics give the ambient display nothing to show', () => {
  const plain = { ...song, synced: false, lines: song.lines.map((l) => ({ ...l, startMs: null })) };
  for (const lyrics of [null, plain]) {
    assert.deepEqual(lyricMoment(lyrics, 20_000), { current: -1, progress: 0, next: -1, resting: false });
  }
});

test('the stage plays synced lines along, and shows untimed ones to scroll', () => {
  const plain: PublicLyricsPayload = { ...synced, synced: false, lines: [{ startMs: null, text: 'a' }] };
  const none: PublicLyricsPayload = { ...synced, synced: false, lines: [] };
  assert.equal(syncedLyricsReady({ status: 'ready', lyrics: synced }), true);
  assert.equal(plainLyricsReady({ status: 'ready', lyrics: synced }), false);
  assert.equal(syncedLyricsReady({ status: 'ready', lyrics: plain }), false);
  assert.equal(plainLyricsReady({ status: 'ready', lyrics: plain }), true);
  for (const lyrics of [none, null]) {
    assert.equal(syncedLyricsReady({ status: 'ready', lyrics }), false);
    assert.equal(plainLyricsReady({ status: 'ready', lyrics }), false);
  }
  assert.equal(syncedLyricsReady({ status: 'loading', lyrics: synced }), false, 'only a settled answer');
});

test('the settings say what a track has, and why there is nothing', () => {
  const plain: PublicLyricsPayload = { ...synced, synced: false, lines: [{ startMs: null, text: 'a' }] };
  const none: PublicLyricsPayload = { ...synced, synced: false, lines: [] };
  const note = (status: Parameters<typeof lyricsNote>[0]['status'], lyrics: PublicLyricsPayload | null, shown = true) =>
    lyricsNote({ status, lyrics }, shown);
  assert.equal(note('ready', synced, false), 'Hidden on this device.', 'hidden says so, whatever the track has');
  assert.match(note('ready', { ...synced, source: 'lrclib' }), /from LRCLIB/);
  assert.match(note('ready', { ...synced, source: 'music-server' }), /station’s library/);
  assert.match(note('ready', synced), /station’s library/, 'an older station names no source');
  assert.match(note('ready', plain), /Not timed/);
  assert.match(note('ready', { ...plain, pending: true }), /still looking/);
  assert.equal(note('ready', none), 'No lyrics for this song.');
  assert.equal(note('ready', { ...none, pending: true }), 'Looking for lyrics…');
  assert.equal(note('loading', null), 'Looking for lyrics…');
  assert.match(note('unavailable', null), /Trying again/);
  assert.match(note('disabled', null), /switched off/);
  assert.equal(note('gone', null), 'No lyrics for this song.');
});
