import assert from 'node:assert/strict';
import { toPublicLyricsPayload } from '../src/music/lyrics-public.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

console.log('public lyrics payload:');

test('empty when there is no current library song', () => {
  assert.deepEqual(toPublicLyricsPayload(null, null), {
    songId: null,
    synced: false,
    offsetMs: 0,
    lines: [],
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
      2500,
    ),
    {
      songId: 'abc123',
      synced: true,
      offsetMs: 2500,
      lines: [
        { startMs: 1000, text: 'first line' },
        { startMs: 3000, text: 'second line' },
      ],
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
      -400,
    ),
    {
      songId: 'abc123',
      synced: false,
      offsetMs: -400,
      lines: [{ startMs: null, text: 'plain lyric line' }],
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
    { songId: 'abc123', synced: false, offsetMs: 0, lines: [] },
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
    },
  );
});

if (failures) {
  console.error(`\n✗ ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n✓ all public lyrics payload checks passed');
