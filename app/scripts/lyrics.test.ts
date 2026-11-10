import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  lyricsSettled,
  lyricsStep,
  lyricWordCount,
  lyricWordParts,
  parseLyricsPayload,
  pendingRecheckDelayMs,
  LYRIC_OFFSET_MAX_MS,
  LYRIC_OFFSET_MIN_MS,
  LYRICS_SOURCES,
  PENDING_MAX_ASKS,
  LINE_HOLD_MS,
  TEASE_MS,
  type TrackAnswer,
} from '../src/lib/lyrics.ts';
import type { PublicLyricsPayload } from '../src/lib/types.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const APP = read('../src/lib/lyrics.ts');
const WEB = read('../../web/components/skins/lyrics.ts');
const CLIENT = read('../../web/lib/stationClient.ts');
const SCHEMA = read('../../controller/src/schemas/lyrics.ts');

/** The source from `from` (a `{` or `(`) to its match, comments stripped and
 *  whitespace collapsed, so only the code is compared. */
function balanced(source: string, from: number): string {
  const open = source[from];
  const close = open === '{' ? '}' : ')';
  let end = from;
  for (let depth = 0; ; end++) {
    if (source[end] === open) depth++;
    else if (source[end] === close && --depth === 0) break;
  }
  return source.slice(from, end + 1).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ');
}

/** The body of `export function name`: past its parameter list, whose
 *  destructuring may hold braces, to the end of its block. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} is missing`);
  const params = source.indexOf('(', start);
  return balanced(source, source.indexOf('{', params + balanced(source, params).length));
}

function constant(source: string, name: string): string {
  const match = source.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(match, `${name} is missing`);
  return match[1].trim();
}

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
  assert.equal(activeLyricLineIndex(SYNCED, 0, 0), -1);
  assert.equal(activeLyricLineIndex(SYNCED, 10_000, 0), 0);
  assert.equal(activeLyricLineIndex(SYNCED, 15_000, 0), 1);
  assert.equal(activeLyricLineIndex(SYNCED, 60_000, 0), 2);
  assert.equal(activeLyricLineIndex({ ...SYNCED, synced: false }, 15_000, 0), -1);
  // A correction moves the clock, never the lines.
  assert.equal(activeLyricLineIndex(SYNCED, 9_000, 1_000), 0);
  assert.equal(activeLyricLineIndex(SYNCED, 10_000, -1), -1);
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

test('retries back off to a minute, and a Retry-After waits longer only up to that minute', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((a) => lyricsRetryDelayMs(a, null)), [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(lyricsRetryDelayMs(0, 30), 30_000);
  // A station-read 429 can ask for minutes; an early ask gets another 429
  // without spending an attempt.
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

test('word lighting splits a line into the words its pacing counts', () => {
  for (const text of ['First line here', '  leading and trailing  ', 'tab\tand\nnewline', 'one', '', '   ']) {
    const parts = lyricWordParts(text);
    assert.equal(parts.map((p) => p.part).join(''), text, 'the spaces are kept');
    const words = parts.filter((p) => p.index >= 0);
    assert.equal(words.length, lyricWordCount(text));
    assert.deepEqual(words.map((p) => p.index), words.map((_, i) => i));
  }
});

test('an answer is settled once asking again could not change it', () => {
  assert.equal(lyricsSettled({ status: 'ready', lyrics: SYNCED }), true);
  assert.equal(lyricsSettled({ status: 'ready', lyrics: { ...SYNCED, pending: true } }), false);
  for (const status of ['disabled', 'gone', 'locked'] as const) assert.equal(lyricsSettled({ status, lyrics: null }), true);
  for (const status of ['idle', 'loading', 'unavailable'] as const) assert.equal(lyricsSettled({ status, lyrics: null }), false);
});

const NOTHING: TrackAnswer = { songId: null, status: 'idle', lyrics: null };

test('a reply for the track asked about is shown, and one for any other track is not', () => {
  const ok = lyricsStep('abc', { kind: 'ok', payload: SYNCED }, 0, 0);
  assert.deepEqual(ok.answer(NOTHING), { songId: 'abc', status: 'ready', lyrics: SYNCED });
  assert.equal(ok.askAgainMs, null);
  const other = lyricsStep('xyz', { kind: 'ok', payload: SYNCED }, 0, 0);
  assert.deepEqual(other.answer(NOTHING), { songId: 'xyz', status: 'gone', lyrics: null });
  assert.equal(other.askAgainMs, null);
});

test('a pending reply is shown and rechecked until the cap, then stops saying it is looking', () => {
  const pending = { ...SYNCED, synced: false, lines: [{ startMs: null, text: 'la' }], pending: true };
  const early = lyricsStep('abc', { kind: 'ok', payload: pending }, 0, PENDING_MAX_ASKS - 1);
  assert.equal(early.answer(NOTHING).lyrics?.pending, true);
  assert.equal(early.askAgainMs, 4000);
  assert.equal(early.recheck, true);
  const last = lyricsStep('abc', { kind: 'ok', payload: pending }, 0, PENDING_MAX_ASKS);
  assert.equal(last.answer(NOTHING).lyrics?.pending, false);
  assert.equal(last.askAgainMs, null);
});

test('a refusal or a switched-off panel is final', () => {
  for (const kind of ['locked', 'disabled', 'gone'] as const) {
    const step = lyricsStep('abc', { kind }, 0, 0);
    assert.deepEqual(step.answer({ songId: 'abc', status: 'ready', lyrics: SYNCED }), { songId: 'abc', status: kind, lyrics: null });
    assert.equal(step.askAgainMs, null);
  }
});

test('a station that does not answer is retried on the backoff, counting retries not rechecks', () => {
  const step = lyricsStep('abc', { kind: 'unavailable', retryAfterSec: null }, 2, 3);
  assert.deepEqual(step.answer(NOTHING), { songId: 'abc', status: 'unavailable', lyrics: null });
  assert.equal(step.askAgainMs, 20_000);
  assert.equal(step.recheck, false);
  assert.equal(lyricsStep('abc', { kind: 'unavailable', retryAfterSec: 30 }, 0, 0).askAgainMs, 30_000);
});

test('lyrics already showing stay up through a failed recheck, no longer claiming more is coming', () => {
  const plain = { ...SYNCED, synced: false, lines: [{ startMs: null, text: 'la' }], pending: true };
  const failed = lyricsStep('abc', { kind: 'unavailable', retryAfterSec: null }, 0, 4);
  const kept = failed.answer({ songId: 'abc', status: 'ready', lyrics: plain });
  assert.equal(kept.status, 'ready');
  assert.deepEqual(kept.lyrics?.lines, plain.lines);
  assert.equal(kept.lyrics?.pending, false);
  assert.equal(lyricsNote(kept, true), 'Not timed, so they don’t follow the song. Scroll through them.');
  // Another track's lyrics are never kept for this one.
  assert.deepEqual(failed.answer({ songId: 'old', status: 'ready', lyrics: plain }), { songId: 'abc', status: 'unavailable', lyrics: null });
});

// The copies this file keeps of the web's lyrics and the controller's schema
// (see its header). A failure here means one side moved: carry the change
// across, then update the expectation.

test('the shared pure functions keep the web player’s bodies', () => {
  for (const name of [
    'syncedLyricsReady',
    'plainLyricsReady',
    'lyricsNote',
    'clampLyricOffsetMs',
    'formatLyricOffset',
    'activeLyricLineIndex',
    'lyricMoment',
    'pendingRecheckDelayMs',
    'lyricsRetryDelayMs',
  ]) {
    assert.equal(functionBody(APP, name), functionBody(WEB, name), `${name} differs from web/components/skins/lyrics.ts`);
  }
});

test('the shared timings and steps keep the web player’s values', () => {
  for (const name of [
    'LYRIC_OFFSET_STEP_MS',
    'LYRIC_OFFSET_NUDGE_MS',
    'LYRICS_LAYOUT_HOLD_MS',
    'RETRY_BASE_MS',
    'RETRY_MAX_MS',
    'PENDING_RECHECK_MS',
    'PENDING_MAX_ASKS',
    'WORD_MS',
    'MIN_SUNG_MS',
    'LINE_HOLD_MS',
    'TEASE_MS',
  ]) {
    assert.equal(constant(APP, name), constant(WEB, name), `${name} differs from web/components/skins/lyrics.ts`);
  }
  assert.equal(constant(read('../src/player/StageLyrics.tsx'), 'TICK_MS'), constant(read('../../web/components/skins/classic/AmbientLyrics.tsx'), 'TICK_MS'));
});

test('each status maps to the result the web player maps it to', () => {
  const start = CLIENT.indexOf('currentLyrics:');
  const block = CLIENT.slice(start, CLIENT.indexOf('\n    },\n', start));
  const pairs = [...block.matchAll(/r\.status === (\d+)\) return \{ kind: '(\w+)' \}/g)];
  assert.deepEqual(pairs.map(([, status]) => Number(status)).sort(), [401, 403, 409]);
  for (const [, status, kind] of pairs) assert.equal(lyricsResultFor(Number(status), null, undefined).kind, kind);
  assert.match(block, /if \(!r\.ok\) \{[^}]*kind: 'unavailable'/);
});

test('the payload parser knows every field of the controller’s schema, its sources and its bounds', () => {
  const fields = (name: string) => {
    const at = SCHEMA.indexOf(`${name} = z.object(`);
    assert.ok(at >= 0, `${name} is missing`);
    return [...balanced(SCHEMA, SCHEMA.indexOf('{', at)).matchAll(/[{,] (\w+):/g)].map(([, key]) => key);
  };
  assert.deepEqual(fields('publicLyricsPayloadSchema'), ['songId', 'synced', 'offsetMs', 'lines', 'source', 'pending']);
  assert.deepEqual(fields('publicLyricLineSchema'), ['startMs', 'text']);
  assert.deepEqual([...constant(SCHEMA, 'LYRICS_SOURCES').matchAll(/'([^']+)'/g)].map(([, s]) => s), [...LYRICS_SOURCES]);
  assert.equal(Number(constant(SCHEMA, 'LYRIC_OFFSET_MIN_MS').replace(/_/g, '')), LYRIC_OFFSET_MIN_MS);
  assert.equal(Number(constant(SCHEMA, 'LYRIC_OFFSET_MAX_MS').replace(/_/g, '')), LYRIC_OFFSET_MAX_MS);
});
