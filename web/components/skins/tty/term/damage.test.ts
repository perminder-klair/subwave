// What a frame repaints decides how many canvas calls it costs, and on
// Safari the calls are the cost: changed cells, merged into runs that never
// wrap a row, and the scaled glow layer's cells tiling without gaps.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellEdges, forEachRun, markDamage } from './damage';
import { Grid } from './grid';

const runs = (marks: number[], cols: number) => {
  const out: [number, number][] = [];
  forEachRun(marks, cols, (start, length) => out.push([start, length]));
  return out;
};

const damage = (prev: Grid, next: Grid) => {
  const marks = new Uint8Array(next.chars.length);
  const dirty = markDamage(next.chars, next.ink, prev.chars, prev.ink, marks);
  return { dirty, marks: [...marks] };
};

test('only cells whose glyph or colour changed are marked', () => {
  const prev = new Grid(5, 1);
  prev.text(0, 0, 'abcde', 1);
  const next = new Grid(5, 1);
  next.text(0, 0, 'abXde', 1);
  next.set(4, 0, 'e', 2);
  assert.deepEqual(damage(prev, next), { dirty: 2, marks: [0, 0, 1, 0, 1] });
});

test('a wide glyph is repainted whole when either half changes', () => {
  const prev = new Grid(4, 1);
  prev.text(0, 0, '音', 1);
  const next = new Grid(4, 1);
  next.text(0, 0, '音', 1);
  next.set(1, 0, 'x', 1); // over the tail: the head is blanked too
  assert.deepEqual(damage(prev, next).marks, [1, 1, 0, 0]);

  // A wide glyph drawn where narrow ones were covers its tail cell too.
  const narrow = new Grid(4, 1);
  narrow.text(2, 0, 'ab', 1);
  const wide = new Grid(4, 1);
  wide.text(2, 0, 'a', 1);
  wide.text(1, 0, '音', 1);
  assert.deepEqual(damage(narrow, wide).marks, [0, 1, 1, 1]);
});

test('an unchanged frame marks nothing', () => {
  const g = new Grid(3, 2);
  g.text(0, 0, 'abc', 4);
  assert.equal(damage(g, g).dirty, 0);
});

test('changed cells merge into one run per stretch of a row', () => {
  assert.deepEqual(runs([1, 1, 1, 0, 1, 0], 6), [[0, 3], [4, 1]]);
  assert.deepEqual(runs([0, 0, 0, 0], 4), []);
});

test('a run never wraps onto the next row', () => {
  // Two rows of three: the end of the first and the start of the second are
  // neighbours in memory, not on screen.
  assert.deepEqual(runs([0, 1, 1, 1, 1, 0], 3), [[1, 2], [3, 2]]);
  assert.deepEqual(runs([1, 1, 1, 1, 1, 1], 3), [[0, 3], [3, 3]]);
});

test('cell edges at a smaller scale tile the layer with whole pixels', () => {
  const e = cellEdges(5, 17, 0.5);
  assert.deepEqual([...e], [0, 8, 17, 25, 34, 42]);
  for (let i = 0; i < 5; i++) assert.ok(e[i + 1]! > e[i]!, 'every cell keeps some width');
  assert.deepEqual([...cellEdges(3, 10, 1)], [0, 10, 20, 30]);
});
