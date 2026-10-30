// Shared track and stem-render gain resolution (#1240).
// A rendered clip has no liq_amplify, so its baked-in gain must match the drain's
// track stamp. Resolving from the analyzer's leading window used to ignore
// ReplayGain tags, maxBoostDb and peak headroom. These cases pin resolveGainDb
// and the matching queue.applyLoudnessGain stamp.
//
// A boost needs a known peak (music/mix.ts gainForLoudness, music/loudness.ts
// resolveGainDb).
//
// The boost cap alone is not a safety limit: with no peak the headroom check is
// skipped, so a track whose loudness reads quiet went up by the whole
// maxBoostDb (up to 12 dB) into the bus limiter. Both a ReplayGain tag without
// trackPeak and a measurement without peak_db reach that path. Now an unknown
// peak holds the boost at 0 dB, cuts still apply, and the drain says once per
// track why a quiet track was left where it was. A ReplayGain tag with a gain
// but no trackPeak borrows the measured peak instead, unless the station pins
// its loudness source to 'replaygain'.
//
// Offline: every track object carries its own replayGain key, and the library
// is never loaded, so nothing reaches Subsonic or library.db.
// Run: `npm test -- loudness`.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach, describe } from 'node:test';

const root = createTempDir(join(tmpdir(), 'subwave-loudness-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const loudness = await import('../src/music/loudness.js');

before(async () => {
  await settings.load();
  // Defaults are the case that matters: target -14, maxBoost 6, tag-first.
  assert.equal(settings.get().loudness.targetLufs, -14);
  assert.equal(settings.get().loudness.maxBoostDb, 6);
  assert.equal(settings.get().loudness.source, 'replaygain-then-measured');
});

beforeEach(async () => {
  loudness._resetBoostHeldNotesForTests();
  await settings.update({ loudness: { source: 'replaygain-then-measured', targetLufs: -14, maxBoostDb: 10 } });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('a measured track with no peak is not boosted', async () => {
  const gain = await loudness.resolveGainDb({ id: 'm1', replayGain: null, loudnessLufs: -24, peakDb: null });
  assert.equal(gain, 0, 'wants +10, peak unknown → 0 dB');
});

test('a measured track with a peak is boosted up to its headroom', async () => {
  const gain = await loudness.resolveGainDb({ id: 'm2', replayGain: null, loudnessLufs: -24, peakDb: -7 });
  assert.equal(gain, 6, 'headroom to the -1 dBFS ceiling');
});

test('a ReplayGain tag with no trackPeak is not boosted', async () => {
  // trackGain +6 → the file sits at -24 LUFS; no peak anywhere.
  const gain = await loudness.resolveGainDb({ id: 'r1', replayGain: { trackGain: 6 }, loudnessLufs: null, peakDb: null });
  assert.equal(gain, 0);
});

test('a loud track with no peak is still turned down', async () => {
  const gain = await loudness.resolveGainDb({ id: 'c1', replayGain: null, loudnessLufs: -8, peakDb: null });
  assert.equal(gain, -6);
});

test('a held boost is reported once per track, with the gain it wanted', async () => {
  const warnings: string[] = [];
  const onWarn = (m: string) => warnings.push(m);
  const track = { id: 'w1', replayGain: null, loudnessLufs: -21.5, peakDb: null };
  await loudness.resolveGainDb({ ...track }, onWarn);
  await loudness.resolveGainDb({ ...track }, onWarn);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /no peak known for w1/);
  assert.match(warnings[0], /\+7\.5 dB/); // within the 10 dB cap
});

test('nothing is reported when nothing was held', async () => {
  const warnings: string[] = [];
  const onWarn = (m: string) => warnings.push(m);
  await loudness.resolveGainDb({ id: 'n1', replayGain: null, loudnessLufs: -24, peakDb: -20 }, onWarn); // boosted
  await loudness.resolveGainDb({ id: 'n2', replayGain: null, loudnessLufs: -8, peakDb: null }, onWarn); // cut
  await loudness.resolveGainDb({ id: 'n3', replayGain: null, loudnessLufs: -14, peakDb: null }, onWarn); // on target
  await loudness.resolveGainDb({ id: 'n4', replayGain: null, loudnessLufs: -24, peakDb: -0.5 }, onWarn); // no headroom
  await settings.update({ loudness: { maxBoostDb: 0 } });
  await loudness.resolveGainDb({ id: 'n5', replayGain: null, loudnessLufs: -24, peakDb: null }, onWarn); // cut-only station
  // With maxBoostDb 0 (n5) there was no boost to hold back either.
  assert.deepEqual(warnings, []);
});

// A ReplayGain tag with a gain but no trackPeak borrows the measured peak for
// the headroom check, so the tag's whole-file loudness still levels the track.
test('a ReplayGain tag without trackPeak borrows the measured peak', async () => {
  // trackGain +6 → -24 LUFS wants +10; the measured peak -7 leaves 6 dB.
  const gain = await loudness.resolveGainDb({ id: 'b1', replayGain: { trackGain: 6 }, loudnessLufs: -20, peakDb: -7 });
  assert.equal(gain, 6, "the tag's loudness, the measured peak's headroom");
});

test("the tag's own trackPeak wins over the measured one", async () => {
  // trackPeak 0.5 = -6.02 dBFS → 5 dB of headroom, not the measured -20's 10.
  const gain = await loudness.resolveGainDb({
    id: 'b2', replayGain: { trackGain: 6, trackPeak: 0.5 }, loudnessLufs: -20, peakDb: -20,
  });
  assert.equal(gain, 5);
});

test("source 'replaygain' does not borrow a measured peak", async () => {
  await settings.update({ loudness: { source: 'replaygain' } });
  const gain = await loudness.resolveGainDb({ id: 'b3', replayGain: { trackGain: 6 }, loudnessLufs: -20, peakDb: -7 });
  assert.equal(gain, 0, 'no peak from the tag, measurements are off: no boost');
});

test('a borrowed peak never changes a cut', async () => {
  const gain = await loudness.resolveGainDb({ id: 'b4', replayGain: { trackGain: -6 }, loudnessLufs: -30, peakDb: -0.1 });
  assert.equal(gain, -2, "-18 - (-6) = -12 LUFS → -2 dB, from the tag");
});

// The track/render cases use the shipped 6 dB cap; the peak cases above keep
// their wider 10 dB cap so headroom and held-boost warnings stay observable.
describe('track and render gain (#1240)', () => {
  beforeEach(async () => {
    await settings.update({ loudness: { maxBoostDb: 6 } });
  });

  // The tag says -18 - (-4) = -14 LUFS, already at target. The leading
  // window says -20, which used to ask the render for +6 (#1240).
  test('prefers the ReplayGain tag over the measured window', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't1',
      replayGain: { trackGain: -4, trackPeak: 0.9 },
      loudnessLufs: -20,
      peakDb: -1,
    });
    assert.equal(gain, 0, 'tag says the track is already at target');
  });

  // replayGain: null means the file was checked and untagged, so it falls
  // through to the measured value, preserving untagged-library behaviour.
  test('falls through to the measured window when untagged', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't2',
      replayGain: null,
      loudnessLufs: -18,
      peakDb: -12,
    });
    assert.equal(gain, 4, '-18 → -14 is +4 dB, inside every cap');
  });

  // The operator's boost cap, which the render's own ±12 dB clamp ignored.
  test('caps the boost at maxBoostDb, not the render clamp', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't3',
      replayGain: null,
      loudnessLufs: -30,   // raw ask is +16 dB
      peakDb: -20,         // headroom is not the binding limit here
    });
    assert.equal(gain, 6, 'capped at maxBoostDb');
  });

  // maxBoostDb caps only boosts. A loud master still gets the full cut.
  test('pulls a loud master down without the boost cap applying', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't5',
      replayGain: null,
      loudnessLufs: -8,
      peakDb: -0.1,
    });
    assert.equal(gain, -6, 'cut is the full distance to target');
  });

  test('no loudness from any source → null (unity, as before)', async () => {
    const gain = await loudness.resolveGainDb({
      id: 't6',
      replayGain: null,
      loudnessLufs: null,
      peakDb: null,
    });
    assert.equal(gain, null);
  });

  test('null track resolves to null rather than throwing', async () => {
    assert.equal(await loudness.resolveGainDb(null), null);
  });

  // A pinned measured source ignores the tag for both track and render.
  test("source 'measured' ignores a present tag", async () => {
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
  test("source 'replaygain' does not fall back to measured", async () => {
    await settings.update({ loudness: { source: 'replaygain' } });
    const gain = await loudness.resolveGainDb({
      id: 't8',
      replayGain: null,
      loudnessLufs: -18,
      peakDb: -12,
    });
    assert.equal(gain, null, 'untagged file plays at unity under a pinned tag source');
  });

  // The drain's liq_amplify and the renderer's gain_db use the same figure,
  // so a clip matches its neighbouring tracks (#1240).
  test('the drain stamps exactly what the render is handed', async () => {
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
});
