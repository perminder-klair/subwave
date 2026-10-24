// What a frame repaints — a terminal's damage tracking. Pure, so it can be
// tested in Node; AsciiCanvas spends it.
//
// Safari's 2D canvas runs on the CPU and records every call to replay it, so
// there the number of calls is the cost, more than the pixels they touch: a
// scene that changes a few thousand cells a frame paid two clears and a blit
// or two for each. Clears are merged into one per run of changed cells in a
// row, and past FULL_REDRAW_SHARE of the grid one clear of the whole canvas
// and a blit of every inked cell is the cheaper frame.

import { cellWidth } from './grid';

/** Past this share of the grid changed, a frame clears the whole canvas and
 *  repaints every inked cell rather than clearing cell runs one by one. */
export const FULL_REDRAW_SHARE = 0.4;

/** Marks each cell that differs from the last frame — and the other half of
 *  any wide glyph either frame had there, since one blit covers both cells.
 *  Returns how many cells are marked. */
export function markDamage(
  chars: Uint32Array, ink: Uint16Array, prevChars: Uint32Array, prevInk: Uint16Array, marks: Uint8Array,
): number {
  const n = chars.length;
  for (let i = 0; i < n; i++) marks[i] = chars[i] !== prevChars[i] || ink[i] !== prevInk[i] ? 1 : 0;
  for (let i = 0; i < n - 1; i++) {
    if (marks[i + 1] && cellWidth(chars[i]!) === 2) marks[i] = 1;
    if (marks[i] && cellWidth(prevChars[i]!) === 2) marks[i + 1] = 1;
  }
  let dirty = 0;
  for (let i = 0; i < n; i++) dirty += marks[i]!;
  return dirty;
}

/** Calls `fn(start, length)` for each run of consecutive marked cells, in
 *  cell indices. A run never wraps onto the next row. */
export function forEachRun(marks: ArrayLike<number>, cols: number, fn: (start: number, length: number) => void): void {
  const n = marks.length;
  for (let i = 0; i < n;) {
    if (!marks[i]) { i++; continue; }
    const rowEnd = i - (i % cols) + cols;
    let j = i + 1;
    while (j < rowEnd && marks[j]) j++;
    fn(i, j - i);
    i = j;
  }
}

/** Whole-pixel edges for `count` cells of `size` pixels drawn at `scale`:
 *  cell i spans [edges[i], edges[i + 1]). Neighbours share an edge, so a
 *  scaled-down layer can clear one cell without nicking the next. */
export function cellEdges(count: number, size: number, scale: number): Int32Array {
  const edges = new Int32Array(count + 1);
  for (let i = 0; i <= count; i++) edges[i] = Math.floor(i * size * scale);
  return edges;
}
