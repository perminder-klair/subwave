// Unit tests for the audio-mood calibration helpers (music/audio-calibration.ts):
// per-mood baselines, z-centred label selection, the audio-derived energy axis,
// and the composite mood-state hash that decides whether a pass must re-score
// (cosines stale) or merely re-label (calibration stale).
//
// The load-bearing case is `a high-baseline mood no longer wins every track` —
// that IS issue #1362. Run: `npm test -- audio-calibration`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBaselines,
  baselinesUsable,
  centeredScores,
  selectAudioMoods,
  arousalDiff,
  audioEnergy,
  audioEnergyFill,
  audioEnergyOverrule,
  ENERGY_OVERRULE_Z,
  composeMoodStateHash,
  parseMoodStateHash,
  moodPassAction,
  moodStateHashFor,
  prunedBaselines,
  CALIBRATION_VERSION,
  UNCALIBRATED_VERSION,
  MIN_BASELINE_TRACKS,
  ENERGY_HIGH_Z,
} from '../src/music/audio-calibration.js';

// A library where `energetic` sits at a systematically higher cosine than
// `calm` — the exact shape of the reported bug. Both moods vary by the same
// amount around their own centre, so after centring neither has an advantage.
function syntheticLibrary(n: number): Array<Record<string, number>> {
  const rows: Array<Record<string, number>> = [];
  for (let i = 0; i < n; i++) {
    // Deterministic sweep across each mood's own range, no RNG (the repo bans
    // Math.random in test fixtures for reproducibility).
    const t = (i % 100) / 100; // 0…0.99
    rows.push({
      energetic: 0.30 + t * 0.10, // ~0.30–0.40, high baseline
      calm: 0.05 + t * 0.10,      // ~0.05–0.15, low baseline
      night: 0.10 + t * 0.02,     // narrow spread
    });
  }
  return rows;
}

// ── computeBaselines ────────────────────────────────────────────────────────

test('baselines capture each mood mean and spread independently', () => {
  const b = computeBaselines([
    { calm: 0.0, energetic: 1.0 },
    { calm: 1.0, energetic: 3.0 },
  ]);
  assert.equal(b.calm.mean, 0.5);
  assert.equal(b.calm.sd, 0.5);
  assert.equal(b.calm.n, 2);
  assert.equal(b.energetic.mean, 2.0);
  assert.equal(b.energetic.sd, 1.0);
});

test('non-finite scores are excluded from the baseline rather than poisoning it', () => {
  const b = computeBaselines([{ calm: 1 }, { calm: NaN }, { calm: 3 }]);
  assert.equal(b.calm.n, 2, 'NaN row does not count');
  assert.equal(b.calm.mean, 2);
});

test('a mood absent from some tracks keeps its own n', () => {
  const b = computeBaselines([{ calm: 1, rare: 5 }, { calm: 3 }]);
  assert.equal(b.calm.n, 2);
  assert.equal(b.rare.n, 1);
});

test('baselines are refused below the calibration floor', () => {
  assert.equal(baselinesUsable(computeBaselines(syntheticLibrary(10))), false);
  assert.equal(baselinesUsable(computeBaselines(syntheticLibrary(MIN_BASELINE_TRACKS))), true);
  assert.equal(baselinesUsable(null), false);
  assert.equal(baselinesUsable({}), false, 'empty baseline set is unusable');
});

test('a mood below the floor is pruned, not allowed to ride an established one', () => {
  // The failure this guards: gating on the MAXIMUM n let a mood scored on a
  // handful of tracks into the baselines beside moods scored on thousands. Its
  // sd is near-degenerate, so its z explodes and it wins every track — the very
  // failure calibration exists to fix, one mood at a time.
  const rows = syntheticLibrary(MIN_BASELINE_TRACKS);
  rows[0].newcomer = 0.9; // a vocabulary entry added since the last re-score
  const pruned = prunedBaselines(computeBaselines(rows))!;
  assert.ok(pruned, 'the library is still calibrated on its established moods');
  assert.ok(pruned.energetic, 'a mood that clears the floor survives');
  assert.equal(pruned.newcomer, undefined, 'the thin mood is dropped from the baselines');
  // Dropped from the baselines means centeredScores drops it too, rather than
  // passing a raw cosine through onto a z axis.
  assert.equal(centeredScores({ energetic: 0.35, newcomer: 0.9 }, pruned).newcomer, undefined);
});

test('pruning everything is the same as having no baselines', () => {
  assert.equal(prunedBaselines(computeBaselines(syntheticLibrary(10))), null);
  assert.equal(prunedBaselines(null), null);
  assert.equal(prunedBaselines({}), null);
});

// ── the uncalibrated stamp ──────────────────────────────────────────────────

test('a pass that could not calibrate does not stamp itself as current', () => {
  // The bug: a library under the floor was labelled on raw cosines but stamped
  // with the real CALIBRATION_VERSION, so once it grew past the floor
  // moodPassAction said 'none' and those tracks stayed on raw selection
  // forever. Stamping version 0 leaves the relabel owed.
  const vocab = 'abc123';
  const uncalibrated = moodStateHashFor(vocab, false);
  assert.equal(parseMoodStateHash(uncalibrated)!.version, UNCALIBRATED_VERSION);
  assert.equal(
    moodPassAction(uncalibrated, vocab),
    'relabel',
    'a grown library re-derives labels rather than reporting nothing to do',
  );
  // And a real calibrated pass still settles.
  assert.equal(moodStateHashFor(vocab, true), composeMoodStateHash(vocab, CALIBRATION_VERSION));
  assert.equal(moodPassAction(moodStateHashFor(vocab, true), vocab), 'none');
});

// ── centeredScores ──────────────────────────────────────────────────────────

test('centring expresses each score in that mood own standard deviations', () => {
  const b = computeBaselines([{ calm: 0 }, { calm: 2 }]); // mean 1, sd 1
  assert.equal(centeredScores({ calm: 2 }, b).calm, 1);
  assert.equal(centeredScores({ calm: 1 }, b).calm, 0);
  assert.equal(centeredScores({ calm: 0 }, b).calm, -1);
});

test('a mood with no baseline is dropped, never mixed in raw', () => {
  const b = computeBaselines([{ calm: 0 }, { calm: 2 }]);
  const z = centeredScores({ calm: 2, brandNew: 0.9 }, b);
  assert.deepEqual(Object.keys(z), ['calm'], 'raw cosines never share an axis with z-scores');
});

test('a zero-variance mood cannot explode into a runaway winner', () => {
  const b = computeBaselines([{ flat: 0.2 }, { flat: 0.2 }, { flat: 0.2 }]);
  const z = centeredScores({ flat: 0.2 }, b);
  assert.ok(Number.isFinite(z.flat), 'no divide-by-zero');
  // Not exactly 0: the running-variance residue is ~1e-17 and the sd floor
  // divides it by 1e-3. Bounded and inert — what matters is that a
  // zero-variance mood scores as average rather than as a runaway winner.
  assert.ok(Math.abs(z.flat) < 1e-9, `expected ~0, got ${z.flat}`);
});

// ── selectAudioMoods — the #1362 regression ─────────────────────────────────

test('a high-baseline mood no longer wins every track (issue #1362)', () => {
  const lib = syntheticLibrary(400);
  const b = computeBaselines(lib);

  // Uncalibrated, `energetic` wins literally every track in this library
  // because its prompt simply sits higher in CLAP's space.
  const rawWins = lib.filter((s) => topMood(selectAudioMoods(s, null)) === 'energetic').length;
  assert.equal(rawWins, lib.length, 'precondition: raw selection is dominated by one mood');

  // Calibrated, the winner tracks which mood is actually high FOR THIS LIBRARY,
  // so a track at the bottom of the energetic range and the top of the calm one
  // comes out calm.
  const calmTrack = { energetic: 0.30, calm: 0.15, night: 0.10 };
  assert.equal(topMood(selectAudioMoods(calmTrack, b)), 'calm');

  const energeticTrack = { energetic: 0.40, calm: 0.05, night: 0.10 };
  assert.equal(topMood(selectAudioMoods(energeticTrack, b)), 'energetic');
});

test('calibrated selection spreads labels across the vocabulary', () => {
  const lib = syntheticLibrary(400);
  const b = computeBaselines(lib);
  const wins = new Set(lib.map((s) => topMood(selectAudioMoods(s, b))));
  assert.ok(wins.size > 1, `expected more than one mood to ever win, got ${[...wins]}`);
});

test('thin baselines fall back to raw selection, unchanged from pre-calibration', () => {
  const scores = { energetic: 0.35, calm: 0.10 };
  const thin = computeBaselines(syntheticLibrary(5));
  assert.deepEqual(
    selectAudioMoods(scores, thin),
    selectAudioMoods(scores, null),
    'below the floor, behaviour is byte-for-byte the old path',
  );
});

test('selection keeps its shape: best-first, margin, cap', () => {
  const b = computeBaselines(syntheticLibrary(400));
  const picked = selectAudioMoods({ energetic: 0.40, calm: 0.15, night: 0.12 }, b, { max: 2 });
  assert.ok(picked.length <= 2, 'cap holds on the calibrated axis');
  assert.deepEqual(selectAudioMoods({}, b), [], 'empty score map yields no labels');
});

function topMood(labels: string[]): string | null {
  return labels[0] ?? null;
}

// ── audio-derived energy ────────────────────────────────────────────────────

// A library where the arousal moods vary enough to build real baselines.
function energyLibrary(n: number): Array<Record<string, number>> {
  const rows: Array<Record<string, number>> = [];
  for (let i = 0; i < n; i++) {
    const t = (i % 100) / 100;
    rows.push({
      energetic: 0.1 + t * 0.2, workout: 0.1 + t * 0.2, driving: 0.1 + t * 0.2,
      celebratory: 0.1 + t * 0.2, festival: 0.1 + t * 0.2,
      calm: 0.3 - t * 0.2, reflective: 0.3 - t * 0.2, spiritual: 0.3 - t * 0.2,
      focus: 0.3 - t * 0.2, night: 0.3 - t * 0.2,
    });
  }
  return rows;
}

test('a loud track reads high and a quiet one reads low', () => {
  const b = computeBaselines(energyLibrary(400));
  const loud = {
    energetic: 0.30, workout: 0.30, driving: 0.30, celebratory: 0.30, festival: 0.30,
    calm: 0.10, reflective: 0.10, spiritual: 0.10, focus: 0.10, night: 0.10,
  };
  const quiet = {
    energetic: 0.10, workout: 0.10, driving: 0.10, celebratory: 0.10, festival: 0.10,
    calm: 0.30, reflective: 0.30, spiritual: 0.30, focus: 0.30, night: 0.30,
  };
  assert.equal(audioEnergy(loud, b), 'high');
  assert.equal(audioEnergy(quiet, b), 'low');
});

test('the ambiguous middle returns null rather than guessing "medium"', () => {
  const b = computeBaselines(energyLibrary(400));
  const middling = {
    energetic: 0.20, workout: 0.20, driving: 0.20, celebratory: 0.20, festival: 0.20,
    calm: 0.20, reflective: 0.20, spiritual: 0.20, focus: 0.20, night: 0.20,
  };
  assert.equal(
    audioEnergy(middling, b),
    null,
    'a propagated guess is only ever overruled by decisive audio',
  );
});

test('energy is refused when the vocabulary lost one side of the axis', () => {
  // An operator who renamed/deleted the low-energy moods leaves no axis to
  // measure against; a one-sided answer would be worse than none.
  const lib = Array.from({ length: 400 }, (_, i) => ({
    energetic: 0.1 + ((i % 100) / 100) * 0.2,
    workout: 0.1 + ((i % 100) / 100) * 0.2,
  }));
  const b = computeBaselines(lib);
  assert.equal(audioEnergy({ energetic: 0.30, workout: 0.30 }, b), null);
});

test('an EMPTY energy is filled three ways: the measured middle is medium', () => {
  const b = computeBaselines(energyLibrary(400));
  const side = (hi: number, lo: number) => ({
    energetic: hi, workout: hi, driving: hi, celebratory: hi, festival: hi,
    calm: lo, reflective: lo, spiritual: lo, focus: lo, night: lo,
  });
  assert.equal(audioEnergyFill(side(0.30, 0.10), b), 'high');
  assert.equal(audioEnergyFill(side(0.10, 0.30), b), 'low');
  assert.equal(audioEnergyFill(side(0.20, 0.20), b), 'medium', 'no guess to keep, so the middle band is a reading');
  // Same thresholds as the correction: the fill and audioEnergy agree wherever the latter answers.
  for (const [hi, lo] of [[0.30, 0.10], [0.10, 0.30], [0.26, 0.14], [0.14, 0.26]]) {
    const two = audioEnergy(side(hi, lo), b);
    if (two) assert.equal(audioEnergyFill(side(hi, lo), b), two);
  }
});

test('the overrule answers only in the strong band, and only to disagree', () => {
  const b = computeBaselines(energyLibrary(400));
  const side = (hi: number, lo: number) => ({
    energetic: hi, workout: hi, driving: hi, celebratory: hi, festival: hi,
    calm: lo, reflective: lo, spiritual: lo, focus: lo, night: lo,
  });
  const loud = side(0.30, 0.10);
  assert.ok(arousalDiff(loud, b)! >= ENERGY_OVERRULE_Z, 'fixture is in the strong band');
  assert.equal(audioEnergyOverrule(loud, b, 'low'), 'high');
  assert.equal(audioEnergyOverrule(loud, b, 'medium'), 'high');
  assert.equal(audioEnergyOverrule(loud, b, 'high'), null, 'agreement changes nothing');
  assert.equal(audioEnergyOverrule(side(0.10, 0.30), b, 'high'), 'low');
  // Decisive for the propagated correction, but short of the strong band.
  const mild = side(0.22, 0.18);
  const d = arousalDiff(mild, b)!;
  assert.ok(d >= 0.35 && d < ENERGY_OVERRULE_Z, `fixture sits between the thresholds (got ${d.toFixed(2)})`);
  assert.equal(audioEnergyOverrule(mild, b, 'low'), null);
  assert.equal(audioEnergyOverrule(loud, null, 'low'), null, 'no baselines, no overrule');
});

test('the fill gives nothing when the audio cannot be scored', () => {
  assert.equal(audioEnergyFill({ energetic: 0.9, calm: 0.1 }, null), null);
  const oneSided = computeBaselines(Array.from({ length: 400 }, (_, i) => ({
    energetic: 0.1 + ((i % 100) / 100) * 0.2, workout: 0.1 + ((i % 100) / 100) * 0.2,
  })));
  assert.equal(audioEnergyFill({ energetic: 0.30, workout: 0.30 }, oneSided), null, 'no axis, no reading');
});

test('energy is refused without usable baselines', () => {
  assert.equal(audioEnergy({ energetic: 0.9, calm: 0.1 }, null), null);
  assert.equal(arousalDiff({ energetic: 0.9, calm: 0.1 }, null), null);
});

test('the arousal diff is signed and clears the threshold it is tested against', () => {
  const b = computeBaselines(energyLibrary(400));
  const loud = {
    energetic: 0.30, workout: 0.30, driving: 0.30, celebratory: 0.30, festival: 0.30,
    calm: 0.10, reflective: 0.10, spiritual: 0.10, focus: 0.10, night: 0.10,
  };
  const diff = arousalDiff(loud, b)!;
  assert.ok(diff >= ENERGY_HIGH_Z, `expected diff ${diff} to clear ${ENERGY_HIGH_Z}`);
  assert.ok(diff > 0, 'high-arousal side is the positive direction');
});

// ── mood-state hash ─────────────────────────────────────────────────────────

test('the composite hash round-trips vocabulary and calibration version', () => {
  const s = composeMoodStateHash('abc123', 7);
  assert.deepEqual(parseMoodStateHash(s), { vocabHash: 'abc123', version: 7 });
});

test('a legacy bare hash reads as pre-calibration, so its labels are due a redo', () => {
  assert.deepEqual(parseMoodStateHash('abc123'), { vocabHash: 'abc123', version: 0 });
  assert.equal(parseMoodStateHash(null), null);
});

test('a malformed version degrades to 0 rather than throwing', () => {
  assert.deepEqual(parseMoodStateHash('abc:notanumber'), { vocabHash: 'abc:notanumber', version: 0 });
  assert.deepEqual(parseMoodStateHash('abc:-1'), { vocabHash: 'abc:-1', version: 0 });
});

test('a vocabulary change re-scores; a calibration change only re-labels', () => {
  const vocab = 'vocabhash';
  assert.equal(moodPassAction(null, vocab), 'rescore', 'never run → full score');
  assert.equal(moodPassAction('otherhash:2', vocab), 'rescore', 'cosines are stale');
  assert.equal(
    moodPassAction(composeMoodStateHash(vocab, CALIBRATION_VERSION - 1), vocab),
    'relabel',
    'cosines fine, labels stale — must not need the analyzer',
  );
  assert.equal(moodPassAction(composeMoodStateHash(vocab), vocab), 'none');
});

test('an install upgrading from pre-calibration relabels rather than re-scoring', () => {
  // The upgrade path that matters: ANALYZER_HEAVY is opt-in, so most installs
  // cannot re-score on demand. A bare legacy hash must still get calibrated.
  assert.equal(moodPassAction('legacyvocabhash', 'legacyvocabhash'), 'relabel');
});
