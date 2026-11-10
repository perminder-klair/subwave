// V3AlertDialog fires at most one action per opening (#2018). Radix keeps a
// closing dialog's buttons live through its exit animation, so a double-click
// on the Dash's "block + skip now" ran the block twice and the skip twice.
// The latch is the rule; web/ has no DOM to click the rendered dialog with.
//
// Run: npm test -- alert-dialog

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionLatch } from './alert-dialog';

test('a double-click fires the action once', () => {
  const latch = actionLatch();
  let fired = 0;
  latch.once(() => { fired++; })();
  // The dialog re-renders between the clicks, so the second press reaches a
  // fresh wrapper around the same action.
  latch.once(() => { fired++; })();
  assert.equal(fired, 1);
});

test('confirm and the alternative share one latch: the first press wins', () => {
  const latch = actionLatch();
  const pressed: string[] = [];
  latch.once(() => pressed.push('block, let it finish'))();
  latch.once(() => pressed.push('block + skip now'))();
  assert.deepEqual(pressed, ['block, let it finish']);
});

test('the next opening re-arms it', () => {
  const latch = actionLatch();
  let fired = 0;
  latch.once(() => { fired++; })();
  latch.arm();
  latch.once(() => { fired++; })();
  assert.equal(fired, 2);
});
