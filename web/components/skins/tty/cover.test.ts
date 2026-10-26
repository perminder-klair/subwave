// The ASCII cover earns a dense glyph by contrast with the background in
// either direction, so a mid-tone theme shows the dark half of a cover as
// well as the light half.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Grid, SPACE } from './term/grid';
import { CUBE } from './term/palette';
import { drawCover } from './cover';

const pixels = (...rgb: Array<[number, number, number]>) => Uint8ClampedArray.from(rgb.flatMap(c => [...c, 255]));

test('a pixel matching the background prints nothing; a far one prints dense', () => {
  const g = new Grid(2, 1);
  drawCover(g, pixels([16, 14, 12], [250, 250, 250]), [16, 14, 12]);
  assert.equal(g.chars[0], SPACE);
  assert.match(String.fromCodePoint(g.chars[1]!), /[$@B%&8]/);
});

test('contrast counts both ways on a mid-tone background', () => {
  const g = new Grid(2, 1);
  drawCover(g, pixels([0, 0, 0], [255, 255, 255]), [14, 61, 145]);
  assert.notEqual(g.chars[0], SPACE, 'black on blue still prints');
  assert.notEqual(g.chars[1], SPACE);
});

test('each glyph takes the xterm colour nearest its pixel', () => {
  const g = new Grid(1, 1);
  drawCover(g, pixels([255, 0, 0]), [243, 239, 230]);
  assert.equal(g.ink[0], CUBE + 5 * 36);
});
