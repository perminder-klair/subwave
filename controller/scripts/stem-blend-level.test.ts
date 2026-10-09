// Pins the loudness figure a stem-blend clip is rendered at (#1240).
//
// A rendered transition clip carries NO liq_amplify of its own
// (subsonic.getClipUri deliberately omits it), so whatever the render bakes in
// IS the level it airs at — sitting between two tracks that were each stamped
// by the queue drain. Before this, stem-blend.ts handed the analyzer the raw
// `loudnessLufs` and let the worker normalise from it, which diverged from the
// drain's own answer three ways at once:
//
//   1. it ignored embedded ReplayGain tags — the DEFAULT source — while using
//      a figure measured over the leading 40s window ALONE;
//   2. it clamped at ±12 dB instead of the operator's maxBoostDb (6 by default);
//   3. it never capped the boost by the track's real peak headroom.
//
// So the clip played at a different level than the tracks either side of it
// ("the stem files aren't being volume matched to the regular track"). The fix
// is that both consumers now resolve through ONE function, music/loudness.ts —
// these tests pin its answers, and the last one pins that queue's
// applyLoudnessGain stamps exactly what the render would receive.
//
// Offline by construction: every track object here carries its own replayGain
// key and complete measured values, so nothing reaches Subsonic or library.db.
// Temp STATE_DIR + real settings.load()/update(), matching
// scripts/house-rules.test.ts.
// Run: `tsx scripts/stem-blend-level.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-blend-level-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const loudness = await import('../src/music/loudness.js');

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

try {
  await settings.load();
  // Defaults are the case that matters: target -14, maxBoost 6, tag-first.
  assert.equal(settings.get().loudness.targetLufs, -14);
  assert.equal(settings.get().loudness.maxBoostDb, 6);
  assert.equal(settings.get().loudness.source, 'replaygain-then-measured');

  console.log('resolveGainDb:');

  // A tagged track whose tag and measured window DISAGREE — the exact shape
  // the render used to get wrong. The tag's loudness is the R128 reference
  // minus trackGain (mix.loudnessFromReplayGain): -18 - (-4) = -14 LUFS, i.e.
  // already at target, so the answer is 0 dB. The measured window claims -20,
  // which would have asked for +6.
  await test('prefers the ReplayGain tag over the measured window', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't1',
      replayGain: { trackGain: -4, trackPeak: 0.9 },
      loudnessLufs: -20,
      peakDb: -1,
    });
    assert.equal(gain, 0, 'tag says the track is already at target');
  });

  // Untagged file (replayGain: null — "asked, nothing there") falls through to
  // the measured value, which is the pre-existing behaviour for an untagged
  // library and must not change.
  await test('falls through to the measured window when untagged', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't2',
      replayGain: null,
      loudnessLufs: -18,
      peakDb: -12,
    });
    assert.equal(gain, 4, '-18 → -14 is +4 dB, inside every cap');
  });

  // The operator's boost cap, which the render's own ±12 dB clamp ignored.
  await test('caps the boost at maxBoostDb, not the render clamp', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't3',
      replayGain: null,
      loudnessLufs: -30,   // raw ask is +16 dB
      peakDb: -20,         // headroom is not the binding limit here
    });
    assert.equal(gain, 6, 'capped at maxBoostDb');
  });

  // Peak headroom binds before the boost cap — the render had no equivalent,
  // so a quiet-but-hot-peaked track was boosted into the limiter.
  await test('caps the boost by real peak headroom', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't4',
      replayGain: null,
      loudnessLufs: -22,   // raw ask is +8, boost cap would allow 6
      peakDb: -3,          // only 2 dB to the -1 dBFS ceiling
    });
    assert.equal(gain, 2, 'headroom wins over the boost cap');
  });

  // Cuts are not capped by maxBoostDb (that is boost-only) but by the wide cut
  // clamp — a loud master still gets pulled down to target.
  await test('pulls a loud master down without the boost cap applying', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't5',
      replayGain: null,
      loudnessLufs: -8,
      peakDb: -0.1,
    });
    assert.equal(gain, -6, 'cut is the full distance to target');
  });

  await test('no loudness from any source → null (unity, as before)', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't6',
      replayGain: null,
      loudnessLufs: null,
      peakDb: null,
    });
    assert.equal(gain, null);
  });

  await test('null track resolves to null rather than throwing', async () => {
    assert.equal(await loudness.resolveGainDb(null), null);
  });

  // `source: 'measured'` must skip the tag entirely — an operator who pins the
  // measured value gets it on BOTH the track and the clip.
  await test("source 'measured' ignores a present tag", async () => {
    await settings.update({ loudness: { source: 'measured' } });
    const gain = await loudness.resolveGainDb({
      id: 't7',
      replayGain: { trackGain: -4, trackPeak: 0.9 }, // would say 0 dB
      loudnessLufs: -18,
      peakDb: -12,
    });
    assert.equal(gain, 4, 'measured window, not the tag');
  });

  // …and `source: 'replaygain'` must not fall back to the measurement.
  await test("source 'replaygain' does not fall back to measured", async () => {
    await settings.update({ loudness: { source: 'replaygain' } });
    const gain = await loudness.resolveGainDb({
      id: 't8',
      replayGain: null,
      loudnessLufs: -18,
      peakDb: -12,
    });
    assert.equal(gain, null, 'untagged file plays at unity under a pinned tag source');
  });

  console.log('\nqueue.applyLoudnessGain ↔ render input:');

  // The contract the whole fix rests on: the dB the drain stamps as
  // liq_amplify on a track is the SAME number stem-blend hands the worker as
  // gain_db. If these ever diverge again, the clip drifts off its neighbours.
  await test('the drain stamps exactly what the render is handed', async () => {
    await settings.update({ loudness: { source: 'replaygain-then-measured' } });
    const { queue } = await import('../src/broadcast/queue.js');
    const track: Parameters<typeof queue.applyLoudnessGain>[0] = {
      id: 't9',
      title: 'A song',
      replayGain: { trackGain: -6, trackPeak: 0.5 },
      loudnessLufs: -25,
      peakDb: -30,
    };
    await queue.applyLoudnessGain(track);
    const rendered = await loudness.resolveGainDb({ ...track });
    assert.equal(track.gainDb, rendered, 'stamped gain === render gain');
    // And it is the tag's answer (-18 - -6 = -12 LUFS → -2 dB), not the
    // measured window's (+6 after the cap).
    assert.equal(track.gainDb, -2);
  });

  if (failures) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll stem-blend level tests passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
