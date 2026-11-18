// The cover as a terminal would print it (jp2a --colors, chafa): one
// character per cell, picked by how far the pixel stands from the
// background in either direction, coloured with the nearest xterm-256
// entry. A theme's background can sit anywhere from black to paper — a
// mid-blue one has as much room below it as above — so contrast, not
// brightness, is what earns a pixel a dense glyph.

import type { Grid } from './term/grid';
import { cube, lightness, type Rgb } from './term/palette';

/** Sparse to dense, as a character's ink coverage rises. */
const RAMP = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

/** `px` is RGBA for a cols × rows image — one pixel per cell. */
export function drawCover(g: Grid, px: ArrayLike<number>, bg: Rgb): void {
  const bgL = lightness(bg);
  const room = Math.max(bgL, 1 - bgL);
  const last = RAMP.length - 1;
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const i = (y * g.cols + x) * 4;
      const rgb: Rgb = [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0];
      const v = Math.pow(Math.min(1, Math.abs(lightness(rgb) - bgL) / room), 0.8);
      const ch = RAMP[Math.round(v * last)]!;
      if (ch !== ' ') g.set(x, y, ch, cube(rgb[0], rgb[1], rgb[2]));
    }
  }
}
