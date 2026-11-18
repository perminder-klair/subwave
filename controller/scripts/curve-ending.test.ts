// The tail facet's level readings derived from the whole-file
// loudness curve (music/curve-ending.ts). Pins:
//   - the window is the 20 s before the music's end, read from the edges when
//     measured, else from the curve's last point over the absolute gate;
//   - a fade is an end FADE_DROP_DB or more under the window's 95th
//     percentile, a cold end is less;
//   - the wind-down starts WIND_DOWN_LAG_MS before the last point within
//     WIND_DOWN_DB of that reference, clamped to the window;
//   - the tail loudness is the gated power mean of the window;
//   - no tail series, no end, or too few points: null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCurveEnding, musicEndMs, FADE_DROP_DB, OUTRO_WINDOW_MS, WIND_DOWN_LAG_MS,
} from '../src/music/curve-ending.js';
import { audibleEndSec } from '../src/music/loudness-curve.js';
import type { WholeLoudnessCurve } from '../src/music/whole-loudness-curve.js';

const STEP = 500;
// A tail series from a level function of absolute ms, 30 s before `endMs` to
// 5 s after it, as the worker stores it (tenths, silence at -1000).
function curveOf(endMs: number, level: (t: number) => number | null): WholeLoudnessCurve {
  const startMs = endMs - 30_000;
  const lufs: number[] = [];
  for (let t = startMs; t <= endMs + 5_000; t += STEP) {
    const v = level(t);
    lufs.push(v == null ? -1000 : Math.round(v * 10));
  }
  return { whole: { startMs: 3000, stepMs: 1000, lufs: [-140] }, tail: { startMs, stepMs: STEP, lufs } };
}
const END = 200_000;

test('a level ending is cold, its wind-down at the very end', () => {
  const c = curveOf(END, t => (t <= END ? -10 : null));
  const d = deriveCurveEnding(c, { decodedDurationMs: END + 4_000, edgeTailMs: 4_000 })!;
  assert.equal(d.musicEndMs, END);
  assert.equal(d.ending, 'cold');
  assert.equal(d.endDropDb, 0);
  assert.equal(d.startMs, END - WIND_DOWN_LAG_MS);
  assert.equal(d.lufs, -10);
});

test('a 12 s fade to -30 dB is a fade, its wind-down where the level starts to fall', () => {
  const fadeFrom = END - 12_000;
  const c = curveOf(END, t => (t > END ? null : t <= fadeFrom ? -9 : -9 - (30 * (t - fadeFrom)) / 12_000));
  const d = deriveCurveEnding(c, { decodedDurationMs: END, edgeTailMs: 0 })!;
  assert.equal(d.ending, 'fade');
  assert.ok(d.endDropDb >= FADE_DROP_DB, String(d.endDropDb));
  // The last point within 6 dB of the reference is 2.4 s into the fade; the lag
  // takes it back to (about) where the fall starts.
  assert.ok(Math.abs(d.startMs - fadeFrom) <= 1_000, `${d.startMs} vs ${fadeFrom}`);
  // The tail series is handed over in the stored tail-curve shape, so the
  // audible-end cut reads it unchanged.
  assert.equal(d.loudnessCurve.stepMs, STEP);
  const cut = audibleEndSec(d.loudnessCurve, -9, 20)!;
  assert.ok(cut * 1000 > fadeFrom && cut * 1000 < END, String(cut));
});

test('the threshold: an end 8 dB under is cold, 9 dB under is a fade', () => {
  for (const [drop, want] of [[8, 'cold'], [9, 'fade']] as const) {
    const c = curveOf(END, t => (t > END ? null : t <= END - 6_000 ? -10 : -10 - drop));
    assert.equal(deriveCurveEnding(c, { decodedDurationMs: END, edgeTailMs: 0 })!.ending, want, String(drop));
  }
});

test('without edges, the end is the last point over the absolute gate', () => {
  const c = curveOf(END, t => (t <= END ? -12 : null));
  assert.equal(musicEndMs(c.tail!, null), END);
  assert.equal(musicEndMs(c.tail!, { decodedDurationMs: null, edgeTailMs: 3_000 }), END);
  const d = deriveCurveEnding(c, null)!;
  assert.equal(d.musicEndMs, END);
  assert.equal(d.ending, 'cold');
});

test('trailing silence is outside the window: a hard stop into 10 s of silence stays cold', () => {
  // The edges put the end where the music stops, not at the end of the file.
  const c = curveOf(END, t => (t <= END ? -11 : null));
  const d = deriveCurveEnding(c, { decodedDurationMs: END + 10_000, edgeTailMs: 10_000 })!;
  assert.equal(d.ending, 'cold');
});

test('the wind-down start never leaves the window', () => {
  const c = curveOf(END, t => (t > END ? null : -20));
  const d = deriveCurveEnding(c, { decodedDurationMs: END, edgeTailMs: 0 })!;
  assert.ok(d.startMs >= END - OUTRO_WINDOW_MS && d.startMs <= END);
});

test('no tail series, no end or too few points: null', () => {
  assert.equal(deriveCurveEnding(null), null);
  assert.equal(deriveCurveEnding({ whole: { startMs: 3000, stepMs: 1000, lufs: [] } }), null);
  const silent = curveOf(END, () => null);
  assert.equal(deriveCurveEnding(silent, null), null, 'no point over the gate: no end');
  // An end 1 s into the series: fewer than 4 points in the window.
  const short = curveOf(END, t => (t <= END ? -12 : null));
  assert.equal(deriveCurveEnding(short, { decodedDurationMs: short.tail!.startMs + 1_000, edgeTailMs: 0 }), null);
});
