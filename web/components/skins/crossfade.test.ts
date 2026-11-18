// The two-layer crossfade behind Classic's ambient tint and Drift's washes: a
// new value always paints into the layer that is off screen, so no visible
// layer ever repaints mid-fade.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossfadeSettled, crossfadeStart, crossfadeTo } from './crossfade';

test('mounting shows the first value without a fade', () => {
  const s = crossfadeStart('red');
  assert.deepEqual(s, { layers: ['red', 'red'], front: 0, fading: false });
});

test('a new value paints into the hidden layer and fades it in', () => {
  const s = crossfadeTo(crossfadeStart('red'), 'blue', false);
  assert.deepEqual(s, { layers: ['red', 'blue'], front: 1, fading: true });
  // Settled, the next value lands in the layer that just faded out.
  const t = crossfadeTo(crossfadeSettled(s), 'green', false);
  assert.deepEqual(t, { layers: ['green', 'blue'], front: 0, fading: true });
});

test('the value already showing is not a change', () => {
  const s = crossfadeStart('red');
  assert.equal(crossfadeTo(s, 'red', false), s);
  assert.equal(crossfadeTo(s, 'red', true), s);
});

test('a value that lands mid-fade waits, and the latest one wins', () => {
  const fading = crossfadeTo(crossfadeStart('red'), 'blue', false);
  // The outgoing layer is still on screen: leave it alone.
  assert.equal(crossfadeTo(fading, 'green', false), fading);
  const settled = crossfadeSettled(fading);
  assert.deepEqual(crossfadeTo(settled, 'violet', false), {
    layers: ['violet', 'blue'],
    front: 0,
    fading: true,
  });
  // Back to what is already showing by the time the fade ends: nothing to do.
  assert.equal(crossfadeTo(settled, 'blue', false), settled);
});

test('instant swaps at once and never waits', () => {
  const s = crossfadeTo(crossfadeStart('red'), 'blue', true);
  assert.deepEqual(s, { layers: ['red', 'blue'], front: 1, fading: false });
  // Even over a fade that was running when the fade was switched off.
  const fading = crossfadeTo(crossfadeStart('red'), 'blue', false);
  assert.deepEqual(crossfadeTo(fading, 'green', true), {
    layers: ['green', 'blue'],
    front: 0,
    fading: false,
  });
});

test('settling a still state returns it unchanged', () => {
  const s = crossfadeStart('red');
  assert.equal(crossfadeSettled(s), s);
});

test('values compare by identity, so an object value fades only when replaced', () => {
  const a = { vibrant: 'rgb(1, 2, 3)' };
  const s = crossfadeStart(a);
  assert.equal(crossfadeTo(s, a, false), s);
  assert.equal(crossfadeTo(s, { ...a }, false).front, 1);
});
