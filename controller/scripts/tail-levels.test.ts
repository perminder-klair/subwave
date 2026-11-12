// transitions.tailFromCurve, which reads the tail's LEVEL readings
// off the whole-file loudness curve (music/tail-levels.ts) instead of the
// librosa tail facet. Pinned here:
//   - the settings: absent/malformed coerce to off (an upgrade airs as
//     before), strict update, survives a restart, no mixer restart;
//   - curveOutro: no curve or nothing derivable keeps the stored outro whole;
//     a derivable curve replaces ending/startMs/lufs/loudnessCurve, keeps the
//     tempo, grids and vocals, and carries the whole-track series; a curve
//     with no stored outro yields one with no grid and no vocals;
//   - the audible-end cut (music/silence-trim.ts) searches the whole-track
//     series only when the tail series never reaches the threshold, and the
//     usual bounds (only earlier, never at/before cueIn + 1 s) still hold.

import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { coldLoadSettings } from './test-utils/settings.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-tail-levels-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { curveOutro, tailFromCurveOn } = await import('../src/music/tail-levels.js');
const { resolveSilenceTrim, resolveAudibleEnd } = await import('../src/music/silence-trim.js');

// A whole-file curve: `whole` at 1 s from 3 s, `tail` at 0.5 s around `endMs`.
function curveJson(endMs: number, level: (t: number) => number | null, durMs = endMs + 5_000): string {
  const tenths = (v: number | null) => (v == null ? -1000 : Math.round(v * 10));
  const whole: number[] = [];
  for (let t = 3_000; t <= durMs; t += 1_000) whole.push(tenths(level(t)));
  const tail: number[] = [];
  const tailStart = endMs - 30_000;
  for (let t = tailStart; t <= endMs + 5_000; t += 500) tail.push(tenths(level(t)));
  return JSON.stringify({
    whole: { startMs: 3_000, stepMs: 1_000, lufs: whole },
    tail: { startMs: tailStart, stepMs: 500, lufs: tail },
  });
}

const END = 200_000;
// Level at -9 LUFS, then a 12 s fade to -39 at the end.
const fadeLevel = (t: number) => (t > END ? null : t <= END - 12_000 ? -9 : -9 - (30 * (t - (END - 12_000))) / 12_000);
const STORED = {
  startMs: 150_000, ending: 'cold' as const, lufs: -20, bpm: 124, beats: [1, 2], bars: [1], vocalRanges: [],
  loudnessCurve: { startMs: 180_000, stepMs: 500, lufs: [-90] },
};
const EDGES = { decodedDurationMs: END, edgeTailMs: 0 };

test('absent/malformed settings coerce to off', async () => {
  for (const stored of [{}, { transitions: {} }, { transitions: { tailFromCurve: 'yes' } }, { transitions: { tailFromCurve: 1 } }]) {
    await coldLoadSettings(stored);
    assert.equal(settings.get().transitions.tailFromCurve, false, JSON.stringify(stored));
    assert.equal(tailFromCurveOn(), false);
  }
  await coldLoadSettings({ transitions: { tailFromCurve: true } });
  assert.equal(tailFromCurveOn(), true);
});

test('update is strict, saves, survives a restart, and needs no mixer restart', async () => {
  await coldLoadSettings({});
  for (const bad of ['on', 1, null]) {
    await assert.rejects(settings.update({ transitions: { tailFromCurve: bad } } as never), /tailFromCurve/, JSON.stringify(bad));
  }
  const { requiresRestart } = await settings.prepareUpdate({ transitions: { tailFromCurve: true } } as never);
  assert.equal(requiresRestart, false, 'not a liquidsoap_*.txt setting');
  await settings.update({ transitions: { tailFromCurve: true } } as never);
  assert.equal(settings.get().transitions.tailFromCurve, true);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().transitions.tailFromCurve, true, 'survives the restart');
  // A patch without the key leaves it alone.
  await settings.update({ transitions: { pairDrain: true } } as never);
  assert.equal(settings.get().transitions.tailFromCurve, true);
});

test('no curve, a malformed one or nothing derivable: the stored outro, untouched', () => {
  assert.equal(curveOutro(STORED, null, EDGES), STORED);
  assert.equal(curveOutro(STORED, '{not json', EDGES), STORED);
  assert.equal(curveOutro(STORED, JSON.stringify({ whole: { startMs: 3000, stepMs: 1000, lufs: [] } }), EDGES), STORED);
  assert.equal(curveOutro(null, null, EDGES), null);
});

test('a derivable curve replaces the four level readings and keeps the rest', () => {
  const o = curveOutro(STORED, curveJson(END, fadeLevel), EDGES)!;
  assert.equal(o.ending, 'fade');
  assert.ok(Math.abs(o.startMs - (END - 12_000)) <= 1_000, String(o.startMs));
  assert.ok(o.lufs != null && o.lufs < -9 && o.lufs > -20, String(o.lufs));
  assert.equal(o.loudnessCurve!.stepMs, 500);
  assert.equal(o.wholeLoudnessCurve!.stepMs, 1_000);
  assert.equal(o.bpm, 124);
  assert.deepEqual(o.beats, [1, 2]);
  assert.deepEqual(o.bars, [1]);
  assert.deepEqual(o.vocalRanges, []);
});

test('a curve with no stored outro yields one with no grid and no vocals', () => {
  const o = curveOutro(null, curveJson(END, t => (t <= END ? -10 : null)), EDGES)!;
  assert.equal(o.ending, 'cold');
  assert.equal(o.bpm, null);
  assert.equal(o.beats, null);
  assert.equal(o.bars, null);
  assert.equal(o.vocalRanges, null);
});

// The Efdemin shape: the music (-10 LUFS) fades out by 160 s, then a drone at
// -48 LUFS tapers to -62 by 200 s. The edges put the end at 200 s (the drone is
// over the -50 dBFS floor), so the whole tail series sits under body - 20.
const DRONE_END = 200_000;
const droneLevel = (t: number) =>
  t > DRONE_END ? null
    : t <= 155_000 ? -10
      : t <= 160_000 ? -10 - (38 * (t - 155_000)) / 5_000
        : t <= 190_000 ? -48 : -48 - (14 * (t - 190_000)) / 10_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const droneTrack = (outro: any) => ({
  id: undefined as string | undefined,
  duration: 205,
  leadSilenceMs: 0,
  tailSilenceMs: 5_000,
  tailStartMs: DRONE_END,
  loudnessLufs: -10,
  outro,
});

test('the audible-end cut falls back to the whole-track series when the tail never reaches it', async () => {
  const o = curveOutro(null, curveJson(DRONE_END, droneLevel, 205_000), { decodedDurationMs: 205_000, edgeTailMs: 5_000 })!;
  assert.equal(o.ending, 'fade', 'the drone tapers off, so it reads as a fade');
  await coldLoadSettings({ transitions: { fadeAudibleEnd: true, fadeAudibleEndDb: 20, tailFromCurve: true } });
  const cut = resolveAudibleEnd(droneTrack(o));
  assert.ok(cut, 'the whole-track series places the end');
  // The last whole point at or above -30 LUFS: 157 s (the fade passes -30 at
  // ~157.6 s).
  assert.equal(cut!.endSec, 157);
  assert.equal(resolveSilenceTrim(droneTrack(o)).cueOutSec, 157);
  // Without the whole series (the switch off: the stored outro has none), no cut.
  const { wholeLoudnessCurve: _w, ...tailOnly } = o;
  assert.equal(resolveAudibleEnd(droneTrack(tailOnly)), null);
});

test('the tail series wins when it reaches the threshold', async () => {
  await coldLoadSettings({ transitions: { fadeAudibleEnd: true, fadeAudibleEndDb: 20, tailFromCurve: true } });
  const o = curveOutro(null, curveJson(END, fadeLevel), EDGES)!;
  // Body -8.75: threshold -28.75, which the fade (2.5 dB/s from 188 s) passes
  // at 195.9 s; the tail's 0.5 s grid says 195.5, the whole series' 1 s grid
  // would say 195.
  const t = { ...droneTrack(o), duration: 200, tailSilenceMs: 0, tailStartMs: END, loudnessLufs: -8.75 };
  assert.equal(resolveAudibleEnd(t)!.endSec, 195.5);
});

test('the whole-series fallback keeps the bounds: never at or before cueIn + 1 s', async () => {
  await coldLoadSettings({ transitions: { fadeAudibleEnd: true, fadeAudibleEndDb: 20, tailFromCurve: true } });
  // Only the first 4 s are loud: the whole-series end would be 4 s.
  const level = (t: number) => (t > DRONE_END ? null : t <= 4_000 ? -10 : -52);
  const o = curveOutro(null, curveJson(DRONE_END, level, 205_000), { decodedDurationMs: 205_000, edgeTailMs: 5_000 })!;
  const t = { ...droneTrack(o), leadSilenceMs: 3_500 };
  await coldLoadSettings({ silenceTrim: { enabled: true }, transitions: { fadeAudibleEnd: true, fadeAudibleEndDb: 20, tailFromCurve: true } });
  const r = resolveSilenceTrim(t);
  assert.ok(r.cueOutSec == null || r.cueOutSec > (r.cueInSec ?? 0) + 1, JSON.stringify(r));
});
