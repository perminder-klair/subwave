// The Subamp meter paints at ~30 fps but was tuned per 60 fps frame, so its
// step is scaled by elapsed time: these pin that one 33 ms paint lands where
// two 60 fps frames did.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRAME_60_MS, stepMeter } from './meter';

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} ≉ ${b}`);

test('one 60 fps frame keeps the per-frame tuning', () => {
  const vals = new Float32Array([0]);
  const caps = new Float32Array([1]);
  stepMeter(vals, caps, [1], FRAME_60_MS);
  close(vals[0] ?? NaN, 0.35);
  // The cap fell 0.006, which still clears the rising bar.
  close(caps[0] ?? NaN, 0.994);
});

test('one 30 fps paint lands where two 60 fps frames did', () => {
  const a = { vals: new Float32Array([0.2, 0.9]), caps: new Float32Array([0.8, 0.95]) };
  const b = { vals: new Float32Array(a.vals), caps: new Float32Array(a.caps) };
  const targets = [0.7, 0.1];
  stepMeter(a.vals, a.caps, targets, FRAME_60_MS);
  stepMeter(a.vals, a.caps, targets, FRAME_60_MS);
  stepMeter(b.vals, b.caps, targets, 2 * FRAME_60_MS);
  for (let i = 0; i < 2; i++) {
    close(a.vals[i] ?? NaN, b.vals[i] ?? NaN, `bar ${i}`);
    close(a.caps[i] ?? NaN, b.caps[i] ?? NaN, `cap ${i}`);
  }
});

test('a cap never sits below its bar', () => {
  const vals = new Float32Array([0.1]);
  const caps = new Float32Array([0.1]);
  stepMeter(vals, caps, [1], 5 * FRAME_60_MS);
  assert.ok((caps[0] ?? 0) >= (vals[0] ?? 0));
  // A long gap (a tab coming back) settles rather than overshoots.
  stepMeter(vals, caps, [0.5], 60_000);
  close(vals[0] ?? NaN, 0.5);
  close(caps[0] ?? NaN, 0.5);
});

test('no time, no movement', () => {
  const vals = new Float32Array([0.3]);
  const caps = new Float32Array([0.6]);
  stepMeter(vals, caps, [1], 0);
  close(vals[0] ?? NaN, 0.3);
  close(caps[0] ?? NaN, 0.6);
});
