// The grid is what every TTY drawing writes into, and a song title can be
// in any script — so wide glyphs, clipping and wrapping are pinned here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Grid, SPACE, WIDE_TAIL, cellWidth, fitText, textCols, wrapText } from './grid';

const row = (g: Grid, y: number) =>
  Array.from(g.chars.subarray(y * g.cols, (y + 1) * g.cols), cp => (cp === WIDE_TAIL ? '_' : String.fromCodePoint(cp))).join('');

test('cell widths follow wcwidth for the scripts a title carries', () => {
  assert.equal(cellWidth('A'.codePointAt(0)!), 1);
  assert.equal(cellWidth('é'.codePointAt(0)!), 1);
  assert.equal(cellWidth('音'.codePointAt(0)!), 2);
  assert.equal(cellWidth('한'.codePointAt(0)!), 2);
  assert.equal(cellWidth('Ａ'.codePointAt(0)!), 2);
  assert.equal(cellWidth(0x0301), 0); // a combining accent rides the glyph before it
  assert.equal(textCols('音楽 ok'), 7);
});

test('text writes wide glyphs over two cells and reports what it used', () => {
  const g = new Grid(10, 1);
  assert.equal(g.text(1, 0, 'a音b', 1), 4);
  assert.equal(row(g, 0), ' a音_b     ');
});

test('text stops at the cell budget rather than splitting a wide glyph', () => {
  const g = new Grid(10, 1);
  assert.equal(g.text(0, 0, 'ab音', 1, 3), 2);
  assert.equal(row(g, 0).trimEnd(), 'ab');
});

test('overwriting either half of a wide glyph blanks the other half', () => {
  const g = new Grid(4, 1);
  g.text(0, 0, '音', 1);
  g.set(1, 0, 'x', 1);
  assert.equal(row(g, 0), ' x  ');
  g.text(0, 0, '音', 1);
  g.set(0, 0, 'y', 1);
  assert.equal(row(g, 0), 'y   ');
});

test('writes off the grid, or at NaN, are dropped', () => {
  const g = new Grid(3, 2);
  g.set(-1, 0, 'x', 1);
  g.set(3, 0, 'x', 1);
  g.set(0, 2, 'x', 1);
  g.set(NaN, 0, 'x', 1);
  g.set(0, NaN, 'x', 1);
  assert.ok(g.chars.every(cp => cp === SPACE));
  assert.equal(g.get(NaN, 0), SPACE);
});

test('coordinates round to the nearest cell', () => {
  const g = new Grid(3, 1);
  g.set(1.4, 0.2, 'x', 2);
  assert.equal(row(g, 0), ' x ');
  assert.equal(g.ink[1], 2);
});

test('fitText ellipsises by cells, not by code units', () => {
  assert.equal(fitText('short', 10), 'short');
  assert.equal(fitText('a long title', 7), 'a long…');
  assert.equal(textCols(fitText('音楽音楽音楽', 7)), 7);
  assert.equal(fitText('anything', 0), '');
});

test('wrapText fills lines greedily and ellipsises past the limit', () => {
  assert.deepEqual(wrapText('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText('one two three four', 9, 2), ['one two', 'three fo…']);
  assert.deepEqual(wrapText('supercalifragilistic', 6), ['super…']);
});

test('a box frames its edges and can blank its inside', () => {
  const g = new Grid(5, 3);
  g.fill(0, 0, 5, 3, '#', 1);
  g.box(0, 0, 5, 3, 1, 'round', 0);
  assert.deepEqual([row(g, 0), row(g, 1), row(g, 2)], ['╭───╮', '│   │', '╰───╯']);
});
