// The AXO loop repaints only what it writes, so what it skips is pinned here:
// a repeated value is never written twice, and on touch WebKit it runs every
// other frame whatever the display's rate.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOUCH_FRAME_MS, createWriter, frameGate, type LoopNode } from './loop';

function node() {
  const calls: string[] = [];
  const el: LoopNode = {
    setAttribute: (n, v) => { calls.push(`set ${n}=${v}`); },
    removeAttribute: n => { calls.push(`remove ${n}`); },
    style: {
      setProperty: (p, v) => { calls.push(`style ${p}=${v}`); },
      removeProperty: p => { calls.push(`unstyle ${p}`); return ''; },
    },
  };
  return { el, calls };
}

test('a value is written once, then only when it changes', () => {
  const w = createWriter();
  const { el, calls } = node();
  w.attr(el, 'transform', 'rotate(1.0)');
  w.attr(el, 'transform', 'rotate(1.0)');
  w.attr(el, 'transform', 'rotate(2.0)');
  w.attr(el, 'transform', null);
  w.attr(el, 'transform', null);
  w.attr(el, 'transform', 'rotate(2.0)');
  assert.deepEqual(calls, ['set transform=rotate(1.0)', 'set transform=rotate(2.0)', 'remove transform', 'set transform=rotate(2.0)']);
});

test('the first write always lands, even a removal', () => {
  // The loop can't know what React printed, so a fresh run writes once.
  const { el, calls } = node();
  createWriter().attr(el, 'transform', null);
  createWriter().style(el, 'opacity', null);
  assert.deepEqual(calls, ['remove transform', 'unstyle opacity']);
});

test('attributes, styles and nodes are remembered apart', () => {
  const w = createWriter();
  const a = node();
  const b = node();
  w.attr(a.el, 'opacity', '0');
  w.style(a.el, 'opacity', '0');
  w.style(a.el, 'opacity', '0');
  w.style(b.el, 'opacity', '0');
  assert.deepEqual(a.calls, ['set opacity=0', 'style opacity=0']);
  assert.deepEqual(b.calls, ['style opacity=0']);
});

/** How many of `seconds` worth of rAF timestamps at `hz` a gate lets through,
 *  with each timestamp jittered by up to a millisecond either way. */
function framesThrough(gate: (now: number) => boolean, hz: number, seconds = 2): number {
  let through = 0;
  for (let i = 0; i < hz * seconds; i++) {
    const jitter = ((i * 7919) % 200) / 100 - 1;
    if (gate((i * 1000) / hz + jitter)) through++;
  }
  return through;
}

test('the touch gate runs about 30 frames a second at 60 and 120 Hz', () => {
  for (const hz of [60, 120]) {
    const n = framesThrough(frameGate(TOUCH_FRAME_MS), hz);
    assert.ok(n >= 58 && n <= 62, `${n} frames in 2 s at ${hz} Hz`);
  }
});

test('an open gate lets every frame through', () => {
  assert.equal(framesThrough(frameGate(0), 60), 120);
});
