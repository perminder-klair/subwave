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

if (failures) {
  console.error(`\n✗ ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n✓ all public lyrics payload checks passed');
