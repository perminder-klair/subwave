// Unit tests for the DJ transition-effect helpers in music/mix.ts — the pure
// maths behind the sweep/washout gate (PR #606 rework). Run:
// `npx tsx scripts/mix-fx.test.ts`. Matches the node:assert-via-tsx style of
// scripts/llm-pure.test.ts.

import assert from 'node:assert/strict';
import {
  washoutCrossSecondsFor,
  washoutDelayFor,
  effectAllowedFor,
  gainForLoudness,
  WASHOUT_CROSS_TARGET_SECONDS,
  CROSS_MAX_SECONDS,
  LOUDNESS_MAX_BOOST_DB,
  LOUDNESS_CUT_CLAMP_DB,
} from '../src/music/mix.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  console.log('washoutCrossSecondsFor (canvas: bar snap, clamps, ceiling):');

  await test('snaps to whole bars of the flagged track', () => {
    // 120 BPM → bar = 2s → 6 bars = exactly the 12s target.
    assert.equal(washoutCrossSecondsFor({ bpm: 120, key: null }), 12);
    // 100 BPM → bar = 2.4s → round(12 / 2.4) = 5 bars = 12s.
    assert.equal(washoutCrossSecondsFor({ bpm: 100, key: null }), 12);
    // 140 BPM → bar ≈ 1.714s → 7 bars = 12s target again.
    assert.equal(washoutCrossSecondsFor({ bpm: 140, key: null }), 12);
    // 70 BPM → bar ≈ 3.43s → round(3.5) = 4 bars ≈ 13.7s (within [8,14]).
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

  await test('dotted eighth of the track tempo', () => {
    // 120 BPM → beat 0.5s → dotted eighth 0.375s.
    assert.equal(washoutDelayFor(120), 0.38);
    // 100 BPM → 0.45s (right at the clamp edge).
    assert.equal(washoutDelayFor(100), 0.45);
  });

  await test('clamped for extreme tempi', () => {
    assert.equal(washoutDelayFor(60), 0.45);   // slow → capped high
    assert.equal(washoutDelayFor(300), 0.18);  // fast → capped low
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

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall mix-fx tests passed');
}

main();
