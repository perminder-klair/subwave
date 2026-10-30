// The AXO drawing is painted back to front by hand, so the orders it relies
// on are pinned here rather than left to the eye.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { project } from '@/components/iso/geometry';
import { LID, LID_SHEET, lidWorld } from './geometry';

test('the open dust cover stays wholly behind the plinth', () => {
  // AxoScene draws the cover before the turntable, so the plinth covers its
  // foot. A cover leaning forward of its hinge line would sit over the
  // plinth's top and want drawing after it instead.
  for (const dy of [0, LID.d]) {
    for (const dz of [0, LID.h]) {
      const [y, z] = lidWorld(dy, dz);
      assert.ok(y <= LID.y + 1e-9, `corner (${dy}, ${dz}) comes forward to y = ${y}`);
      assert.ok(z >= LID.z - LID.h, `corner (${dy}, ${dz}) sinks to z = ${z}`);
    }
  }
});

test('the hinge edge stays on the hinge line', () => {
  assert.deepEqual(lidWorld(0, 0), [LID.y, LID.z]);
});

test('the lid sheet lands on the cover panel', () => {
  // The focus screen is laid out flat and carried onto the glass by this one
  // matrix; it must agree with the projection the panel itself is drawn by.
  const [a, b, c, d, e, f] = LID_SHEET.m;
  for (const [u, v] of [[0, 0], [LID_SHEET.w, 0], [0, LID_SHEET.h], [LID_SHEET.w, LID_SHEET.h], [97, 41]] as const) {
    const [px, py] = project(LID.x0 + u, ...lidWorld(LID.d - v, LID.h));
    assert.ok(Math.abs(a * u + c * v + e - px) < 0.05, `x off at (${u}, ${v})`);
    assert.ok(Math.abs(b * u + d * v + f - py) < 0.05, `y off at (${u}, ${v})`);
  }
});

test('the lid sheet reads left to right, and the walls leave most of it clear', () => {
  assert.equal(LID_SHEET.mirrored, false);
  const { x0, y0, x1, y1 } = LID_SHEET.clear;
  assert.ok(x0 >= 0 && y0 >= 0 && x1 <= LID_SHEET.w && y1 <= LID_SHEET.h);
  assert.ok(x1 - x0 > LID_SHEET.w * 0.8 && y1 - y0 > LID_SHEET.h * 0.8, JSON.stringify(LID_SHEET.clear));
});
