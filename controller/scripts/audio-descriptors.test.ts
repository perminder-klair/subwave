// The pure half of the CLAP sound descriptors (music/audio-descriptors.ts): the
// vocabulary, per-group selection on the calibrated axis, and the use-time rule
// that hands the vocal question to isInstrumental. The real pass is in
// scripts/audio-descriptor-pass.test.ts.
//
// The distinctiveness test is the one to read before touching DESCRIPTOR_MIN_Z.
// Raw cosines rank prompts, not tracks (#1362), and a word most of a library
// shares clusters nothing (#1246), so the synthetic library below gives every
// label its own prompt bias and gives the instruments a whole scene to share.
// Run: `npm test -- audio-descriptors`.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioDescriptorVocabHash,
  descriptorsSelected,
  DESCRIPTOR_GROUP_CAPS,
  DESCRIPTOR_MIN_Z,
  DESCRIPTOR_VOCAB,
  selectAudioDescriptors,
  usableDescriptors,
  type Descriptor,
  type DescriptorGroup,
} from '../src/music/audio-descriptors.js';
import {
  computeBaselines,
  DEFAULT_MARGIN_SD,
  MIN_BASELINE_TRACKS,
  prunedBaselines,
  type MoodBaselines,
} from '../src/music/audio-calibration.js';

const labelsOf = (group: DescriptorGroup) =>
  DESCRIPTOR_VOCAB.filter((d) => d.group === group).map((d) => d.label);
const groupOf = (label: string) => DESCRIPTOR_VOCAB.find((d) => d.label === label)!.group;

const flat = (sd = 0.05, mean = 0.2, n = 1000): MoodBaselines =>
  Object.fromEntries(DESCRIPTOR_VOCAB.map((d) => [d.label, { mean, sd, n }]));

// z = 0 for every label except the ones named.
const scoresAt = (z: Record<string, number>, sd = 0.05, mean = 0.2) =>
  Object.fromEntries(DESCRIPTOR_VOCAB.map((d) => [d.label, mean + (z[d.label] ?? 0) * sd]));

test('the vocabulary is modest, grouped, unique and fits one text-tower call', () => {
  assert.ok(DESCRIPTOR_VOCAB.length >= 20 && DESCRIPTOR_VOCAB.length <= 30, `${DESCRIPTOR_VOCAB.length} labels`);
  assert.ok(DESCRIPTOR_VOCAB.length <= 64, 'one /embed-text envelope');
  assert.equal(new Set(DESCRIPTOR_VOCAB.map((d) => d.label)).size, DESCRIPTOR_VOCAB.length);
  assert.equal(new Set(DESCRIPTOR_VOCAB.map((d) => d.prompt)).size, DESCRIPTOR_VOCAB.length);
  for (const group of ['instrument', 'vocal', 'production'] as const) {
    assert.ok(labelsOf(group).length > 0, group);
  }
});

test('South Asian instruments sit beside the Western ones', () => {
  const instruments = labelsOf('instrument');
  for (const label of [
    'tabla', 'harmonium', 'dhol', 'sitar',
    'piano', 'acoustic guitar', 'electric guitar', 'synthesizer', 'strings', 'brass', 'saxophone',
  ]) {
    assert.ok(instruments.includes(label), label);
  }
});

test('every prompt is a caption, not the bare label', () => {
  for (const d of DESCRIPTOR_VOCAB) {
    assert.notEqual(d.prompt.toLowerCase(), d.label.toLowerCase(), d.label);
    assert.ok(d.prompt.split(/\s+/).length >= 2, `${d.label}: "${d.prompt}"`);
  }
});

test('the vocabulary hash moves on any label, prompt or group change', () => {
  const base: Descriptor[] = [
    { label: 'piano', group: 'instrument', prompt: 'the sound of a piano' },
    { label: 'choir', group: 'vocal', prompt: 'a choir singing' },
  ];
  const hash = audioDescriptorVocabHash(base);
  assert.equal(hash, audioDescriptorVocabHash(base.map((d) => ({ ...d }))), 'stable');
  assert.equal(hash.length, 16);
  assert.notEqual(hash, audioDescriptorVocabHash([{ ...base[0], prompt: 'piano keys' }, base[1]]));
  assert.notEqual(hash, audioDescriptorVocabHash([{ ...base[0], label: 'keys' }, base[1]]));
  assert.notEqual(hash, audioDescriptorVocabHash([{ ...base[0], group: 'production' }, base[1]]));
  assert.notEqual(hash, audioDescriptorVocabHash([base[1], base[0]]), 'order is identity');
  assert.equal(audioDescriptorVocabHash(), audioDescriptorVocabHash(DESCRIPTOR_VOCAB));
});

test('selection is capped per group, best first inside a group', () => {
  const [i1, i2, i3] = labelsOf('instrument');
  const [v1, v2] = labelsOf('vocal');
  const [p1, p2] = labelsOf('production');
  const hot = DESCRIPTOR_MIN_Z + 1;
  const picked = selectAudioDescriptors(
    scoresAt({
      [i1]: hot, [i2]: hot + 0.1, [i3]: hot + 0.2,
      [v1]: hot, [v2]: hot + 0.1,
      [p1]: hot, [p2]: hot + 0.1,
    }),
    flat(),
  );
  assert.deepEqual(picked, [i3, i2, v2, p2]);
});

test('a second instrument must sit near the first, not merely clear the bar', () => {
  // The real-model failure: a clear acoustic guitar also clears the threshold on
  // electric guitar, one sd further down.
  const [i1, i2] = labelsOf('instrument');
  const top = DESCRIPTOR_MIN_Z + 1;
  assert.deepEqual(
    selectAudioDescriptors(scoresAt({ [i1]: top, [i2]: top - DEFAULT_MARGIN_SD - 0.05 }), flat()),
    [i1],
    'a neighbouring timbre stays out',
  );
  assert.deepEqual(
    selectAudioDescriptors(scoresAt({ [i1]: top, [i2]: top - DEFAULT_MARGIN_SD + 0.05 }), flat()),
    [i1, i2],
    'two instruments really in the mix both stay',
  );
  // The bar still applies inside the margin.
  assert.deepEqual(
    selectAudioDescriptors(scoresAt({ [i1]: DESCRIPTOR_MIN_Z + 0.1, [i2]: DESCRIPTOR_MIN_Z - 0.1 }), flat()),
    [i1],
  );
});

test('the caps are the ones the brief set', () => {
  assert.deepEqual(DESCRIPTOR_GROUP_CAPS, { instrument: 2, vocal: 1, production: 1 });
});

test('a label under the threshold is not selected, however it ranks', () => {
  const [i1] = labelsOf('instrument');
  assert.deepEqual(
    selectAudioDescriptors(scoresAt({ [i1]: DESCRIPTOR_MIN_Z - 0.05 }), flat()),
    [],
    'the best label of a track still has to clear the bar',
  );
  assert.deepEqual(selectAudioDescriptors(scoresAt({ [i1]: DESCRIPTOR_MIN_Z + 0.05 }), flat()), [i1]);
});

test('thresholds apply to the calibrated axis, never the raw cosine', () => {
  const [low, high] = labelsOf('instrument');
  const baselines = flat();
  // `high` sits at a raw 0.40 because its prompt always does; `low` at a raw 0.15
  // is far above its own mean.
  baselines[high] = { mean: 0.4, sd: 0.05, n: 1000 };
  baselines[low] = { mean: 0.05, sd: 0.05, n: 1000 };
  const scores = scoresAt({});
  scores[high] = 0.4;
  scores[low] = 0.15;
  assert.deepEqual(selectAudioDescriptors(scores, baselines), [low]);
});

test('below the baseline floor scores select nothing, with no raw fallback', () => {
  const [i1] = labelsOf('instrument');
  const scores = scoresAt({ [i1]: 5 });
  assert.deepEqual(selectAudioDescriptors(scores, null), []);
  assert.deepEqual(
    selectAudioDescriptors(scores, flat(0.05, 0.2, MIN_BASELINE_TRACKS - 1)),
    [],
    'a baseline under the floor is no baseline',
  );
  assert.deepEqual(selectAudioDescriptors(scores, flat(0.05, 0.2, MIN_BASELINE_TRACKS)), [i1]);
});

test('a label under the floor is pruned while its neighbours keep working', () => {
  const [thin, solid] = labelsOf('instrument');
  const baselines = flat();
  baselines[thin] = { mean: 0.2, sd: 0.05, n: 12 };
  assert.deepEqual(selectAudioDescriptors(scoresAt({ [thin]: 9, [solid]: 2 }), baselines), [solid]);
});

test('a corrupt or foreign score map selects nothing and never throws', () => {
  assert.deepEqual(selectAudioDescriptors({}, flat()), []);
  assert.deepEqual(selectAudioDescriptors({ retired: 0.9 }, { ...flat(), retired: { mean: 0, sd: 0.05, n: 900 } }), []);
  assert.deepEqual(selectAudioDescriptors({ [labelsOf('vocal')[0]]: Number.NaN }, flat()), []);
});

// A deterministic stream, so a failure here reproduces.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

function normalise(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const DIM = 128;

// Scenes of unequal size, each owning a few labels, with a library's usual lopsided
// shape: one scene is 35% of the tracks. Every prompt also sits at its own baseline
// whatever the track, spread wider than a label moves across the library: the
// measured #1362 failure, and why raw cosines rank prompts.
function syntheticLibrary(seed: number, tracks = 4000) {
  const rng = mulberry32(seed);
  const unit = () => normalise(Array.from({ length: DIM }, () => gauss(rng)));
  const scenes = [
    { share: 0.35, labels: ['tabla', 'harmonium', 'dhol', 'male vocals', 'female vocals'] },
    { share: 0.2, labels: ['electric guitar', 'male vocals', 'dense mix'] },
    { share: 0.2, labels: ['synthesizer', 'drum machine', 'heavy bass', 'rap vocals'] },
    { share: 0.15, labels: ['piano', 'saxophone', 'brass', 'female vocals', 'vintage recording'] },
    { share: 0.1, labels: ['strings', 'acoustic guitar', 'choir', 'orchestral'] },
  ].map((s) => ({ ...s, centre: unit() }));

  const prompts = DESCRIPTOR_VOCAB.map((d, i) => {
    const owners = scenes.filter((s) => s.labels.includes(d.label));
    const noise = unit();
    return {
      baseline: 0.8 * ((i * 7) % DESCRIPTOR_VOCAB.length) / DESCRIPTOR_VOCAB.length,
      vector: normalise(noise.map((x, k) => 0.5 * x + owners.reduce((sum, s) => sum + 0.8 * s.centre[k], 0))),
    };
  });

  const maps: Array<Record<string, number>> = [];
  for (let t = 0; t < tracks; t++) {
    let pick = rng();
    let scene = scenes[0];
    for (const s of scenes) {
      if (pick < s.share) { scene = s; break; }
      pick -= s.share;
    }
    const noise = unit();
    const v = normalise(noise.map((x, k) => 0.8 * x + 0.6 * scene.centre[k]));
    const scores: Record<string, number> = {};
    DESCRIPTOR_VOCAB.forEach((d, i) => {
      const cosine = prompts[i].baseline + v.reduce((sum, x, k) => sum + x * prompts[i].vector[k], 0);
      scores[d.label] = Math.round(cosine * 1000) / 1000;
    });
    maps.push(scores);
  }
  return maps;
}

function fireRates(maps: Array<Record<string, number>>, pick: (s: Record<string, number>) => string[]) {
  const fired: Record<string, number> = {};
  for (const scores of maps) for (const l of pick(scores)) fired[l] = (fired[l] ?? 0) + 1;
  return Object.fromEntries(Object.entries(fired).map(([l, n]) => [l, n / maps.length]));
}

test('no label fires on more than about a quarter of a realistic library', () => {
  for (const seed of [1, 2, 3]) {
    const maps = syntheticLibrary(seed);
    const baselines = prunedBaselines(computeBaselines(maps));
    assert.ok(baselines);
    const rates = fireRates(maps, (s) => selectAudioDescriptors(s, baselines));
    const worst = Object.entries(rates).sort((a, b) => b[1] - a[1])[0];
    assert.ok(worst[1] <= 0.25, `seed ${seed}: ${worst[0]} fired on ${(worst[1] * 100).toFixed(1)}%`);
    // The smaller scenes keep their words. A label the 35% scene shares goes quiet,
    // which is the point: it could not clear this bar without labelling the scene.
    for (const label of ['synthesizer', 'electric guitar', 'piano', 'strings', 'rap vocals']) {
      assert.ok((rates[label] ?? 0) > 0.03, `seed ${seed}: ${label} never fires`);
    }

    // The control: the same library picked on raw cosines, which is what the
    // calibration exists to stop. Without this the bound above could pass on a
    // library too easy to prove anything.
    const raw = fireRates(maps, (s) => {
      const top = Object.entries(s).sort((a, b) => b[1] - a[1]);
      const out: string[] = [];
      for (const group of ['instrument', 'vocal', 'production'] as const) {
        out.push(...top.filter(([l]) => groupOf(l) === group)
          .slice(0, DESCRIPTOR_GROUP_CAPS[group]).map(([l]) => l));
      }
      return out;
    });
    const rawWorst = Object.entries(raw).sort((a, b) => b[1] - a[1])[0];
    assert.ok(rawWorst[1] > 0.3, `raw selection is the failure this guards: ${JSON.stringify(raw)}`);
  }
});

test('the threshold bounds a label on any library, not just this one', () => {
  // Cantelli: at most 1 / (1 + k^2) of any distribution sits k sd above its mean.
  assert.ok(1 / (1 + DESCRIPTOR_MIN_Z ** 2) <= 0.25);

  // The adversary is two lumps with the upper one exactly k sd up. A share p sits
  // at sqrt((1 - p) / p), so a label shared by more than the bound falls under the
  // threshold rather than labelling a whole scene, and the worst case is the bound.
  const [shared] = labelsOf('instrument');
  const rateAt = (p: number) => {
    const n = 4000;
    const maps = Array.from({ length: n }, (_, i) => ({ [shared]: i < p * n ? 0.3 : 0.1 }));
    return fireRates(maps, (s) => selectAudioDescriptors(s, prunedBaselines(computeBaselines(maps))))[shared] ?? 0;
  };
  for (const p of [0.05, 0.1, 0.2, 0.24]) assert.equal(rateAt(p), p, `share ${p} is fully labelled`);
  for (const p of [0.26, 0.35, 0.5, 0.8]) assert.equal(rateAt(p), 0, `share ${p} is not`);
});

const vocal = labelsOf('vocal')[0];
const instrument = labelsOf('instrument')[0];
const production = labelsOf('production')[0];

test('vocal labels drop for a measured instrumental and only for one', () => {
  const stored = [instrument, vocal, production];
  assert.deepEqual(
    usableDescriptors({ audioDescriptors: stored, vocalRanges: [] }),
    [instrument, production],
  );
  assert.deepEqual(
    usableDescriptors({ audioDescriptors: stored, vocalRanges: null }),
    stored,
    'unknown is not instrumental',
  );
  assert.deepEqual(
    usableDescriptors({ audioDescriptors: stored }),
    stored,
    'an unmeasured track keeps the hint',
  );
  assert.deepEqual(
    usableDescriptors({ audioDescriptors: stored, vocalRanges: [{ startMs: 0, endMs: 60_000 }] }),
    stored,
    'a sung track keeps it',
  );
  assert.deepEqual(
    usableDescriptors({ audioDescriptors: stored, vocalRanges: [], vocalRangesInvalid: true }),
    stored,
    'an invalid measurement cannot earn instrumental',
  );
});

test('the drop happens at use time, so the verdict can change without a re-score', () => {
  const track: { audioDescriptors: string[]; vocalRanges: unknown[] } = {
    audioDescriptors: [vocal], vocalRanges: [],
  };
  assert.deepEqual(usableDescriptors(track), []);
  track.vocalRanges = [{ startMs: 0, endMs: 60_000 }];
  assert.deepEqual(usableDescriptors(track), [vocal], 'the stored label was kept all along');
});

test('only a calibrated state counts as a station with descriptors', () => {
  assert.equal(descriptorsSelected(null), false, 'never scored');
  assert.equal(descriptorsSelected('abc123:0'), false, 'under the floor, so no labels exist');
  assert.equal(descriptorsSelected('abc123'), false, 'a bare hash reads as uncalibrated');
  assert.equal(descriptorsSelected('abc123:1'), true);
});

test('absent or junk labels read as none', () => {
  assert.deepEqual(usableDescriptors(null), []);
  assert.deepEqual(usableDescriptors({}), []);
  assert.deepEqual(usableDescriptors({ audioDescriptors: null }), []);
  assert.deepEqual(usableDescriptors({ audioDescriptors: ['', '  '] }), []);
});
