// The public lyrics payload (music/lyrics-public.ts): which lines a player
// gets, and on which timeline their timings sit.
//
// Run: `npm test -- lyrics-public`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toPublicLyricsPayload } from '../src/music/lyrics-public.js';

test('empty when there is no current library song', () => {
  assert.deepEqual(toPublicLyricsPayload(null, null), {
    songId: null,
    synced: false,
    offsetMs: 0,
    lines: [],
    source: null,
    pending: false,
  });
});

test('trims blank lines and preserves synced timing', () => {
  assert.deepEqual(
    toPublicLyricsPayload(
      'abc123',
      {
        synced: true,
        lines: [
          { startMs: 1000, text: ' first line ' },
          { startMs: 2000, text: '' },
          { startMs: 3000, text: 'second line' },
        ],
      },
      { offsetMs: 2500 },
    ),
    {
      songId: 'abc123',
      synced: true,
      offsetMs: 2500,
      lines: [
        { startMs: 1000, text: 'first line' },
        { startMs: 3000, text: 'second line' },
      ],
      source: 'music-server',
      pending: false,
    },
  );
});

test('unsynced lyrics publish null start offsets', () => {
  assert.deepEqual(
    toPublicLyricsPayload(
      'abc123',
      {
        synced: false,
        lines: [{ startMs: Number.NaN, text: 'plain lyric line' }],
      },
      { offsetMs: -400 },
    ),
    {
      songId: 'abc123',
      synced: false,
      offsetMs: -400,
      lines: [{ startMs: null, text: 'plain lyric line' }],
      source: 'music-server',
      pending: false,
    },
  );
});

test('an all-marker instrumental body publishes as no lyrics', () => {
  // Timed at 0 and left unfiltered, this single line would read as a synced
  // lyric the player highlights for the whole track.
  assert.deepEqual(
    toPublicLyricsPayload('abc123', {
      synced: true,
      lines: [{ startMs: 0, text: '[au: instrumental]' }],
    }),
    { songId: 'abc123', synced: false, offsetMs: 0, lines: [], source: null, pending: false },
  );
});

test('every instrumental marker spelling is screened off', () => {
  for (const marker of ['Instrumental', 'INSTRUMENTAL', '(instrumental)', '[Instrumental]']) {
    assert.deepEqual(
      toPublicLyricsPayload('abc123', { synced: true, lines: [{ startMs: 0, text: marker }] }).lines,
      [],
      `expected ${marker} to be screened off`,
    );
  }
});

test('a lyric that merely sings the word instrumental survives', () => {
  assert.deepEqual(
    toPublicLyricsPayload('abc123', {
      synced: true,
      lines: [{ startMs: 500, text: 'this is instrumental to me' }],
    }).lines,
    [{ startMs: 500, text: 'this is instrumental to me' }],
  );
});

test('markers are dropped without discarding the real lines around them', () => {
  assert.deepEqual(
    toPublicLyricsPayload('abc123', {
      synced: true,
      lines: [
        { startMs: 0, text: 'Instrumental' },
        { startMs: 4000, text: 'the words start here' },
      ],
    }),
    {
      songId: 'abc123',
      synced: true,
      offsetMs: 0,
      lines: [{ startMs: 4000, text: 'the words start here' }],
      source: 'music-server',
      pending: false,
    },
  );
});

test('timings move onto the played timeline when the head was trimmed', () => {
  // A 6s leading blank at the default min gap plays from 5.75s into the file.
  // A line stamped 8000ms in the file is sung 2.25s after the track starts.
  const payload = toPublicLyricsPayload(
    'abc123',
    {
      synced: true,
      lines: [
        { startMs: 8000, text: 'first sung line' },
        { startMs: 11_500, text: 'second sung line' },
      ],
    },
    { cueInSec: 5.75 },
  );
  assert.deepEqual(payload.lines, [
    { startMs: 2250, text: 'first sung line' },
    { startMs: 5750, text: 'second sung line' },
  ]);
  assert.equal(payload.synced, true);
});

test('a line inside the trimmed head lands at the start, never before it', () => {
  const payload = toPublicLyricsPayload(
    'abc123',
    { synced: true, lines: [{ startMs: 3000, text: 'count-in' }, { startMs: 9000, text: 'verse' }] },
    { cueInSec: 5.75 },
  );
  assert.deepEqual(payload.lines.map((l) => l.startMs), [0, 3250]);
});

test('an untrimmed play keeps the file timings exactly', () => {
  for (const cueInSec of [null, undefined]) {
    assert.deepEqual(
      toPublicLyricsPayload('abc123', { synced: true, lines: [{ startMs: 1234, text: 'line' }] }, { cueInSec })
        .lines,
      [{ startMs: 1234, text: 'line' }],
    );
  }
});

test('the station offset rides beside the lines, never folded into them', () => {
  const payload = toPublicLyricsPayload(
    'abc123',
    { synced: true, lines: [{ startMs: 8000, text: 'line' }] },
    { offsetMs: 2900, cueInSec: 2 },
  );
  assert.equal(payload.offsetMs, 2900);
  assert.deepEqual(payload.lines, [{ startMs: 6000, text: 'line' }]);
});

test('the payload names its source, and none when there are no lines', () => {
  const line = { synced: true, lines: [{ startMs: 1000, text: 'line' }] };
  assert.equal(toPublicLyricsPayload('abc123', line, { source: 'lrclib' }).source, 'lrclib');
  assert.equal(toPublicLyricsPayload('abc123', line).source, 'music-server', 'the music server unless told otherwise');
  assert.equal(
    toPublicLyricsPayload('abc123', { synced: true, lines: [{ startMs: 0, text: 'Instrumental' }] }, { source: 'lrclib' }).source,
    null,
  );
  assert.equal(toPublicLyricsPayload('abc123', null, { pending: true }).pending, true, 'pending rides an empty answer too');
});
