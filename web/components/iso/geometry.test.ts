// The isometric kit is shared by the AXO skin and the broadsheet's figures, so
// its projection is pinned here: a change to it moves every drawing at once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COS30, SIN30, boxFaces, drawBlock, poly, project, silhouette } from './geometry';

test('project maps world x down-right, world y down-left and z straight up', () => {
  assert.deepEqual(project(0, 0, 0), [0, 0]);
  assert.deepEqual(project(100, 0, 0), [86.6, 50]);
  assert.deepEqual(project(0, 100, 0), [-86.6, 50]);
  assert.deepEqual(project(0, 0, 100), [0, -100]);
});

test('project rounds to two decimals', () => {
  assert.deepEqual(project(1, 0, 0), [0.87, 0.5]);
});

test('box faces are shear matrices anchored at the right corners', () => {
  const f = boxFaces({ x: 10, y: 20, z: 5, w: 40, d: 30, h: 15 });
  // Top face starts at the back corner, lifted to the box's top.
  assert.equal(f.T, `matrix(${COS30} ${SIN30} ${-COS30} ${SIN30} ${project(10, 20, 20).join(' ')})`);
  // Front-left face starts at the front-left top corner; local y runs straight down.
  assert.equal(f.L, `matrix(${COS30} ${SIN30} 0 1 ${project(10, 50, 20).join(' ')})`);
  // Front-right face starts at the front corner and runs back along −y.
  assert.equal(f.R, `matrix(${COS30} ${-SIN30} 0 1 ${project(50, 50, 20).join(' ')})`);
});

test('silhouette traces the six-corner outline a box shows from the front', () => {
  assert.equal(
    silhouette({ x: 0, y: 0, z: 0, w: 10, d: 10, h: 10 }),
    poly([
      project(0, 0, 10), project(10, 0, 10), project(10, 0, 0),
      project(10, 10, 0), project(0, 10, 0), project(0, 10, 10),
    ]),
  );
});

test('a drawn block carries its faces, its silhouette and its size', () => {
  const b = { x: 10, y: 20, z: 5, w: 40, d: 30, h: 15 };
  assert.deepEqual(drawBlock(b), { ...boxFaces(b), sil: silhouette(b), w: 40, d: 30, h: 15 });
});
