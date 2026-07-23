// Unit tests for the lyric→vocal derivation (music/lyric-vocal.ts): the
// deterministic vocal-activity path built from Navidrome timed lyrics (#1125).
// Run: `tsx scripts/lyric-vocal.test.ts`.
//
// node:assert-via-tsx style, matching scripts/bed-policy.test.ts.

import assert from 'node:assert/strict';
import { deriveVocalFromLyrics } from '../src/music/lyric-vocal.js';

// ── inconclusive inputs → null (fall back to Demucs) ─────────────────────────

// No lyrics indexed at all.
assert.equal(deriveVocalFromLyrics(null), null);

// Unsynced plain text: we know there are words but not WHEN — can't place a cue.
assert.equal(
  deriveVocalFromLyrics({ synced: false, lines: [{ startMs: NaN, text: 'la la la' }] }),
  null,
);

// Synced but every line is blank (section-break timestamps only) → nothing to place.
assert.equal(
  deriveVocalFromLyrics({ synced: true, lines: [{ startMs: 1000, text: '   ' }] }),
  null,
);

// ── explicit instrumental markers → instrumental ([]) ────────────────────────

for (const marker of ['Instrumental', '[au: instrumental]', '(instrumental)', 'INSTRUMENTAL']) {
  const r = deriveVocalFromLyrics({ synced: false, lines: [{ startMs: NaN, text: marker }] });
  assert.deepEqual(
    r,
    { instrumental: true, vocalRanges: [], introMs: null },
    `marker "${marker}" should read instrumental`,
  );
}

// A song that merely SINGS the word must NOT be caught by the marker regex.
assert.notEqual(
  deriveVocalFromLyrics({
    synced: true,
    lines: [{ startMs: 5000, text: 'this is an instrumental kind of love' }],
  })?.instrumental,
  true,
);

// ── synced lyrics → ranges + intro cue ───────────────────────────────────────

// The reporter's case: Fleetwood Mac "The Chain" — a 27s guitar intro that the
// energy/Demucs gate mis-reads as vocals at 4s. The first timed line is the truth.
const chain = deriveVocalFromLyrics({
  synced: true,
  lines: [
    { startMs: 27_930, text: 'Listen to the wind blow' },
    { startMs: 30_880, text: 'Watch the sun rise' },
    { startMs: 35_230, text: '' }, // blank section marker — ignored
    { startMs: 40_960, text: 'Run in the shadows' },
  ],
});
assert.ok(chain && !chain.instrumental);
assert.equal(chain!.introMs, 27_930, 'intro cue is the first SUNG line, not the guitar intro');
// Lines within MERGE_GAP_MS (8s) coalesce into one range.
assert.equal(chain!.vocalRanges.length, 1);
assert.equal(chain!.vocalRanges[0].startMs, 27_930);

// A wide instrumental gap (a solo) splits the ranges so the vocal-free stretch
// is visible — here a >8s gap between the second and third sung line.
const withSolo = deriveVocalFromLyrics({
  synced: true,
  lines: [
    { startMs: 10_000, text: 'verse one' },
    { startMs: 14_000, text: 'verse two' },
    { startMs: 60_000, text: 'after the solo' }, // 46s gap → new range
  ],
});
assert.equal(withSolo!.vocalRanges.length, 2);
assert.equal(withSolo!.vocalRanges[0].startMs, 10_000);
assert.equal(withSolo!.vocalRanges[1].startMs, 60_000);

// Out-of-order timestamps are sorted before ranging.
const unordered = deriveVocalFromLyrics({
  synced: true,
  lines: [
    { startMs: 20_000, text: 'second' },
    { startMs: 5_000, text: 'first' },
  ],
});
assert.equal(unordered!.introMs, 5_000);

// A negative/garbage timestamp is dropped, not clamped into a bogus 0 onset.
const badTs = deriveVocalFromLyrics({
  synced: true,
  lines: [
    { startMs: -1, text: 'ghost' },
    { startMs: 12_000, text: 'real' },
  ],
});
assert.equal(badTs!.introMs, 12_000);

console.log('✓ lyric-vocal.test.ts passed');
