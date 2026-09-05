// Unit tests for the DJ transition-effect helpers in music/mix.ts — the pure
// maths behind the sweep/washout gate (PR #606 rework). Run:
// `npx tsx scripts/mix-fx.test.ts`. Matches the node:assert-via-tsx style of
// scripts/llm-pure.test.ts.

import assert from 'node:assert/strict';
import {
  chopPeriodFor,
  crossSecondsFor,
  endingCrossSecondsFor,
  washoutCrossSecondsFor,
  washoutDelayFor,
  effectAllowedFor,
  gainForLoudness,
  loopBarFor,
  loopCrossSecondsFor,
  loudnessFromReplayGain,
  WASHOUT_CROSS_TARGET_SECONDS,
  CROSS_MAX_SECONDS,
  LOUDNESS_MAX_BOOST_DB,
  LOUDNESS_CUT_CLAMP_DB,
  REPLAYGAIN_REFERENCE_LUFS,
} from '../src/music/mix.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  console.log('tempo-derived timing (octave-error defence):');

  await test('half/double readings produce identical transition timing', () => {
    // The measured failure in #1417 is strictly octave-shaped: slow material
    // at 62–88 BPM is often stored at 124–176. Either reading describes the
    // same rhythmic grid for transition purposes, so no timing consumer may
    // change merely because beat_track chose the other octave.
    const slow = { bpm: 76, key: '8A' };
    const doubled = { bpm: 152, key: '8A' };
    const next = { bpm: 103, key: '3B' };

    assert.equal(crossSecondsFor(slow, next), crossSecondsFor(doubled, next));
    assert.equal(
      endingCrossSecondsFor({ ...slow, ending: 'cold' }, null),
      endingCrossSecondsFor({ ...doubled, ending: 'cold' }, null),
    );
    assert.equal(washoutDelayFor(slow.bpm), washoutDelayFor(doubled.bpm));
    assert.equal(loopBarFor(slow.bpm), loopBarFor(doubled.bpm));
    assert.equal(loopCrossSecondsFor(slow), loopCrossSecondsFor(doubled));
    assert.equal(chopPeriodFor(slow.bpm), chopPeriodFor(doubled.bpm));
    assert.equal(chopPeriodFor(55), chopPeriodFor(110));

    // A second corpus edge catches rounding inside the washout canvas: this
    // pair differs under raw BPM even though 65 and 130 are the same pulse.
    assert.equal(
      washoutCrossSecondsFor({ bpm: 65, key: null }),
      washoutCrossSecondsFor({ bpm: 130, key: null }),
    );
  });

  // Equality between two readings is necessary but NOT sufficient: two equally
  // OFF-grid values compare equal just as happily as two aligned ones, and
  // that is precisely how a clamp applied after the octave fold flattened the
  // whole 110–160 band onto a flat 0.75s chop gate while the invariance test
  // above stayed green. So assert the property the doc comments actually
  // promise: the stamped period is the track's beat (or its dotted eighth)
  // scaled by a power of two, i.e. it lands ON the grid at some octave.
  //
  // `unit` is derived from the RAW bpm on purpose, so this cannot be satisfied
  // by mirroring whatever timingBpm happens to do — any octave of the reading
  // is a power of two away from it either way. Division by an exact power of
  // two is exact in binary FP, so the only slack is the 2-dp stamp rounding,
  // which the expectation reproduces rather than tolerates.
  function assertOnGrid(value: number, unit: number, lo: number, hi: number, label: string) {
    const octave = Math.round(Math.log2(unit / value));
    const exact = unit / Math.pow(2, octave);
    assert.equal(
      value, Math.round(exact * 100) / 100,
      `${label}: ${value}s is not a power-of-two multiple of ${unit}s (nearest is ${exact})`,
    );
    assert.ok(value >= lo && value <= hi, `${label}: ${value}s outside the audible window [${lo}, ${hi}]`);
  }

  await test('effect periods stay on the beat grid across the whole tempo range', () => {
    // 30–300 BPM in 0.1 steps: every real reading, both octaves of it, and the
    // 110 fold boundary from both sides.
    for (let tenths = 300; tenths <= 3000; tenths++) {
      const bpm = tenths / 10;
      const beat = 60 / bpm;
      assertOnGrid(chopPeriodFor(bpm), beat, 0.25, 0.75, `chop @ ${bpm}`);
      assertOnGrid(washoutDelayFor(bpm), 0.75 * beat, 0.18, 0.45, `washout tap @ ${bpm}`);
      assertOnGrid(loopBarFor(bpm), 4 * beat, 1.2, 3.4, `loop bar @ ${bpm}`);
    }
  });

  await test('effect periods are octave-invariant below the 110 fold line too', () => {
    // timingBpm only folds at or above 110, so a true 52 BPM track stored as
    // 104 is left raw — the measured #1417 corpus starts at 124. The effect
    // periods must not care: they fold their own result by powers of two, so
    // they agree on either side of that threshold. The bar-snapped canvases
    // legitimately do not, which is why they are not asserted here.
    for (const bpm of [41.7, 52, 55, 56.2, 63, 76, 104, 109]) {
      assert.equal(chopPeriodFor(bpm), chopPeriodFor(bpm * 2), `chop @ ${bpm}`);
      assert.equal(washoutDelayFor(bpm), washoutDelayFor(bpm * 2), `washout tap @ ${bpm}`);
      assert.equal(loopBarFor(bpm), loopBarFor(bpm * 2), `loop bar @ ${bpm}`);
    }
  });

  await test('the 110–160 band keeps a one-beat chop gate (the #1434 regression)', () => {
    // The clamp-after-fold bug returned a flat 0.75s here — 1.38 beats at 110
    // rising to 1.90 at 152 — so the gate walked the grid and cut mid-note,
    // against chopPeriodFor's own "opens at each beat start" contract.
    assert.equal(chopPeriodFor(110), 0.55);
    assert.equal(chopPeriodFor(120), 0.5);
    assert.equal(chopPeriodFor(128), 0.47);
    assert.equal(chopPeriodFor(140), 0.43);
    // 152 is the doubled reading of 76: half a beat of the folded pulse.
    assert.equal(chopPeriodFor(152), 0.39);
    assert.equal(chopPeriodFor(76), 0.39);
  });

  console.log('washoutCrossSecondsFor (canvas: bar snap, clamps, ceiling):');

  await test('snaps to whole bars of the flagged track', () => {
    // 120 BPM → bar = 2s → 6 bars = exactly the 12s target.
    assert.equal(washoutCrossSecondsFor({ bpm: 120, key: null }), 12);
    // 100 BPM → bar = 2.4s → round(12 / 2.4) = 5 bars = 12s.
    assert.equal(washoutCrossSecondsFor({ bpm: 100, key: null }), 12);
    // 140 is the doubled reading of 70, so both use the slower pulse: bar
    // ≈3.43s → round(3.5) = 4 bars ≈13.7s (within [8,14]).
    assert.equal(washoutCrossSecondsFor({ bpm: 140, key: null }), 13.7);
    assert.equal(washoutCrossSecondsFor({ bpm: 70, key: null }), 13.7);
  });

  await test('unknown BPM → fixed 10s fallback', () => {
    assert.equal(washoutCrossSecondsFor({ bpm: null, key: null }), 10);
    assert.equal(washoutCrossSecondsFor({ bpm: null, key: '8A' }), 10);
    assert.equal(washoutCrossSecondsFor({ bpm: 0, key: null }), 10);
  });

  await test('clamped to [8, 14] regardless of tempo', () => {
    // 30 BPM → bar = 8s → 2 bars = 16s → capped at CROSS_MAX_SECONDS.
    assert.equal(washoutCrossSecondsFor({ bpm: 30, key: null }), CROSS_MAX_SECONDS);
    // Absurdly fast tempo still lands in range.
    const fast = washoutCrossSecondsFor({ bpm: 300, key: null });
    assert.ok(fast >= 8 && fast <= CROSS_MAX_SECONDS, `got ${fast}`);
  });

  await test('admin crossfade ceiling wins over the target', () => {
    assert.equal(washoutCrossSecondsFor({ bpm: 120, key: null }, 9), 9);
    // A ceiling below the 8s floor wins too — an explicit short crossfade is
    // the operator's call (same rule as crossSecondsFor).
    assert.equal(washoutCrossSecondsFor({ bpm: 120, key: null }, 6), 6);
    // A ceiling above CROSS_MAX changes nothing.
    assert.equal(washoutCrossSecondsFor({ bpm: 30, key: null }, 20), CROSS_MAX_SECONDS);
  });

  await test('target constant is what the maths aims at', () => {
    assert.equal(WASHOUT_CROSS_TARGET_SECONDS, 12);
  });

  console.log('washoutDelayFor (tempo-synced comb tap):');

  await test('dotted eighth of the octave-safe timing pulse', () => {
    // 120 folds to the 60 BPM pulse: its 0.75s tap is out of the audible
    // window, so it HALVES to 0.375 — a dotted eighth of the 120 reading and a
    // dotted sixteenth of the folded pulse, which is the same instant.
    assert.equal(washoutDelayFor(120), 0.38);
    // 100 BPM → 0.45s (right at the window edge, no halving needed).
    assert.equal(washoutDelayFor(100), 0.45);
  });

  await test('halved, not clamped, for extreme tempi', () => {
    // Slow → the dotted eighth overshoots the window and halves onto the grid.
    // A clamp would have parked this at the 0.45 ceiling, which is 0.45 of a
    // beat at 60 BPM and a subdivision of nothing.
    assert.equal(washoutDelayFor(60), 0.38);
    // 300 folds through 150 to the 75 BPM pulse, then halves once: 0.3s is
    // 1.5 beats of the raw reading, still on the eighth-note grid.
    assert.equal(washoutDelayFor(300), 0.3);
  });

  await test('unknown BPM → 0.30s neutral default (radio.liq fallback twin)', () => {
    assert.equal(washoutDelayFor(null), 0.3);
    assert.equal(washoutDelayFor(0), 0.3);
    assert.equal(washoutDelayFor(-5), 0.3);
  });

  console.log('effectAllowedFor (the LLM proposes, the data disposes):');

  await test('sweep blocked between tempo/key-locked tracks', () => {
    // Same tempo, same key → mixCompat 1.0 → a beat-blend beats a sweep.
    assert.equal(effectAllowedFor('sweep', { bpm: 124, key: '8A' }, { bpm: 124, key: '8A' }), false);
    // Locked tempo, adjacent key → still ≥ 0.6.
    assert.equal(effectAllowedFor('sweep', { bpm: 124, key: '8A' }, { bpm: 124, key: '9A' }), false);
  });

  await test('sweep allowed on a real clash', () => {
    // Unrelated tempo and key → mixCompat 0.
    assert.equal(effectAllowedFor('sweep', { bpm: 80, key: '3B' }, { bpm: 128, key: '9A' }), true);
    // Big tempo jump, no key data.
    assert.equal(effectAllowedFor('sweep', { bpm: 80, key: null }, { bpm: 128, key: null }), true);
  });

  await test('sweep passes when either side is un-analysed (data cannot contradict)', () => {
    assert.equal(effectAllowedFor('sweep', { bpm: null, key: null }, { bpm: 124, key: '8A' }), true);
    assert.equal(effectAllowedFor('sweep', { bpm: 124, key: '8A' }, { bpm: null, key: null }), true);
  });

  await test('blend is the sweep mirror — compatible pairs only', () => {
    // Locked tempo + key → handover territory.
    assert.equal(effectAllowedFor('blend', { bpm: 124, key: '8A' }, { bpm: 124, key: '8A' }), true);
    // Full clash → the handover would expose it.
    assert.equal(effectAllowedFor('blend', { bpm: 80, key: '3B' }, { bpm: 128, key: '9A' }), false);
    // Un-analysed → trust the DJ.
    assert.equal(effectAllowedFor('blend', { bpm: null, key: null }, { bpm: 124, key: '8A' }), true);
  });

  await test('washout is never data-gated (cooldown rations it)', () => {
    assert.equal(effectAllowedFor('washout', { bpm: 124, key: '8A' }, { bpm: 124, key: '8A' }), true);
    assert.equal(effectAllowedFor('washout', { bpm: null, key: null }, { bpm: null, key: null }), true);
  });

  console.log('gainForLoudness (asymmetric clamp, peak headroom, operator overrides):');

  await test('no measurement → null (unity gain, pre-feature behaviour)', () => {
    assert.equal(gainForLoudness(null), null);
    assert.equal(gainForLoudness(undefined), null);
    assert.equal(gainForLoudness(NaN), null);
  });

  await test('within-cap gains are the exact target distance', () => {
    assert.equal(gainForLoudness(-18), 4);    // quiet → +4 toward −14
    assert.equal(gainForLoudness(-10), -4);   // loud → −4
    assert.equal(gainForLoudness(-14), 0);    // on target → 0
  });

  await test('boost capped at the default max, cut gets the wider clamp', () => {
    // −28 LUFS wants +14 → capped at the default +6.
    assert.equal(gainForLoudness(-28), LOUDNESS_MAX_BOOST_DB);
    // −4 LUFS wants −10 → allowed (cut clamp is 12, not 6).
    assert.equal(gainForLoudness(-4), -10);
    // Absurdly loud still stops at the cut clamp.
    assert.equal(gainForLoudness(0), -LOUDNESS_CUT_CLAMP_DB);
  });

  await test('measured peak headroom caps the boost below the operator max', () => {
    // −28 LUFS, peak −4 dBFS → headroom to the −1 ceiling is 3 dB < cap 9.
    assert.equal(gainForLoudness(-28, { peakDb: -4, maxBoostDb: 9 }), 3);
    // Peak already at/above the ceiling → no boost at all (never negative).
    assert.equal(gainForLoudness(-20, { peakDb: -0.5 }), 0);
    // Plenty of headroom → the operator max is what bites.
    assert.equal(gainForLoudness(-28, { peakDb: -20, maxBoostDb: 9 }), 9);
  });

  await test('peak never limits the cut direction', () => {
    // Loud track with peaks at the ceiling still gets turned down.
    assert.equal(gainForLoudness(-8, { peakDb: -0.1 }), -6);
  });

  await test('operator target and boost-cap overrides apply', () => {
    assert.equal(gainForLoudness(-20, { targetLufs: -16 }), 4);
    assert.equal(gainForLoudness(-10, { targetLufs: -16 }), -6);
    assert.equal(gainForLoudness(-28, { maxBoostDb: 12 }), 12);
    // maxBoostDb 0 = cut-only levelling.
    assert.equal(gainForLoudness(-28, { maxBoostDb: 0 }), 0);
    // Junk overrides fall back to the defaults.
    assert.equal(gainForLoudness(-28, { targetLufs: NaN, maxBoostDb: -3 }), LOUDNESS_MAX_BOOST_DB);
  });

  await test('rounded to 0.1 dB', () => {
    assert.equal(gainForLoudness(-15.55), 1.6);
    assert.equal(gainForLoudness(-13.333), -0.7);
  });

  console.log('loudnessFromReplayGain (OpenSubsonic tag → measured-equivalent shape):');

  await test('trackGain inverts around the −18 LUFS reference', () => {
    assert.equal(REPLAYGAIN_REFERENCE_LUFS, -18);
    // The issue-#998 track: RG trackGain −9.8 dB → the file really sits at −8.2 LUFS.
    assert.deepEqual(loudnessFromReplayGain({ trackGain: -9.8 }), { lufs: -8.2, peakDb: null });
    // A quiet master: +4 of gain needed → −22 LUFS.
    assert.deepEqual(loudnessFromReplayGain({ trackGain: 4 }), { lufs: -22, peakDb: null });
    // Exactly at reference.
    assert.deepEqual(loudnessFromReplayGain({ trackGain: 0 }), { lufs: -18, peakDb: null });
  });

  await test('linear trackPeak converts to dBFS', () => {
    assert.deepEqual(loudnessFromReplayGain({ trackGain: -9.8, trackPeak: 1.0 }), { lufs: -8.2, peakDb: 0 });
    assert.equal(loudnessFromReplayGain({ trackGain: 0, trackPeak: 0.5 })!.peakDb, -6.02);
    // Junk peak (0, negative, non-number) → null peak, gain still usable.
    assert.equal(loudnessFromReplayGain({ trackGain: 0, trackPeak: 0 })!.peakDb, null);
    assert.equal(loudnessFromReplayGain({ trackGain: 0, trackPeak: 'x' })!.peakDb, null);
  });

  await test('untagged / malformed shapes → null (fall through to measured)', () => {
    assert.equal(loudnessFromReplayGain(null), null);
    assert.equal(loudnessFromReplayGain(undefined), null);
    assert.equal(loudnessFromReplayGain({}), null); // Navidrome's empty block for untagged files
    assert.equal(loudnessFromReplayGain({ trackGain: NaN }), null);
    assert.equal(loudnessFromReplayGain({ trackGain: '−9.8' }), null);
    assert.equal(loudnessFromReplayGain('replaygain'), null);
  });

  await test('feeds gainForLoudness like a measurement (end-to-end for #998)', () => {
    // Target −18: the −8.2 LUFS track gets the full −9.8 cut (within the 12 dB clamp)
    // instead of the −4.3 the mis-measured −13.7 produced.
    const rg = loudnessFromReplayGain({ trackGain: -9.8 })!;
    assert.equal(gainForLoudness(rg.lufs, { targetLufs: -18 }), -9.8);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall mix-fx tests passed');
}

main();
