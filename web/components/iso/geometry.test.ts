// The isometric kit is shared by the AXO skin and the broadsheet's figures, so
// its projection is pinned here: a change to it moves every drawing at once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { C, P, S, box, poly, sil } from './geometry';

test('P projects world x down-right, world y down-left and z straight up', () => {
  assert.deepEqual(P(0, 0, 0), [0, 0]);
  assert.deepEqual(P(100, 0, 0), [86.6, 50]);
  assert.deepEqual(P(0, 100, 0), [-86.6, 50]);
  assert.deepEqual(P(0, 0, 100), [0, -100]);
});

test('P rounds to two decimals', () => {
  assert.deepEqual(P(1, 0, 0), [0.87, 0.5]);
});

test('box faces are shear matrices anchored at the right corners', () => {
  const f = box(10, 20, 5, 40, 30, 15);
  // Top face starts at the back corner, lifted to the box's top.
  assert.equal(f.T, `matrix(${C} ${S} ${-C} ${S} ${P(10, 20, 20).join(' ')})`);
  // Front-left face starts at the front-left top corner; local y runs straight down.
  assert.equal(f.L, `matrix(${C} ${S} 0 1 ${P(10, 50, 20).join(' ')})`);
  // Front-right face starts at the front corner and runs back along −y.
  assert.equal(f.R, `matrix(${C} ${-S} 0 1 ${P(50, 50, 20).join(' ')})`);
});

test('sil traces the six-corner outline a box shows from the front', () => {
  assert.equal(
    sil(0, 0, 0, 10, 10, 10),
    poly([P(0, 0, 10), P(10, 0, 10), P(10, 0, 0), P(10, 10, 0), P(0, 10, 0), P(0, 10, 10)]),
  );
});
