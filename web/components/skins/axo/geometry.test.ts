// The AXO drawing is painted back to front by hand, so the orders it relies
// on are pinned here rather than left to the eye.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LID, lidWorld } from './geometry';

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
