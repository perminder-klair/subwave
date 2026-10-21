// figlet without a figlet font: the text is drawn in the theme's own face at
// banner size, then sampled into quadrant-block cells (▘ ▀ ▙ █ …), two
// sub-pixels across and two down per cell. A font table would cover A–Z and
// stop; this covers whatever script the title is in, because the browser
// already knows how to draw it. Long titles wrap onto two lines before they
// shrink below legibility.
//
// Browser-only (it needs a canvas), and cached per text and size — a title
// is rasterised once, not once a frame.

import type { Grid } from './grid';

export interface BannerMask {
  cols: number;
  rows: number;
  /** Per cell, the inked quadrants: 1 upper-left, 2 upper-right, 4 lower-left,
   *  8 lower-right. */
  cells: Uint8Array;
}

const cache = new Map<string, BannerMask | null>();
let scratch: CanvasRenderingContext2D | null = null;

/** Canvas pixels per sub-pixel row. */
const SCALE = 12;

/** One line of text at `rows` cell rows, however wide it comes out;
 *  `squeeze` < 1 condenses the face horizontally. */
function rasterize(text: string, family: string, rows: number, aspect: number, squeeze: number): BannerMask | null {
  scratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const ctx = scratch;
  if (!ctx) return null;
  // A sub-pixel is half a cell each way, so it keeps the cell's proportions.
  const subW = SCALE * aspect;
  const height = rows * 2 * SCALE;
  ctx.font = `800 100px ${family}`;
  const probe = ctx.measureText(text);
  const inkH = probe.actualBoundingBoxAscent + probe.actualBoundingBoxDescent;
  if (!(inkH > 0)) return null;
  const k = height / inkH;
  const spacing = subW * 1.1;
  const inkW = ((probe.actualBoundingBoxLeft + probe.actualBoundingBoxRight) * k
    + spacing * Math.max(0, [...text].length - 1)) * squeeze;
  const subCols = Math.ceil(inkW / subW);
  const cols = Math.ceil(subCols / 2);
  if (cols < 1) return null;

  const cw = Math.ceil(subCols * subW);
  ctx.canvas.width = cw;
  ctx.canvas.height = height;
  ctx.clearRect(0, 0, cw, height);
  ctx.font = `800 ${100 * k}px ${family}`;
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.setTransform(squeeze, 0, 0, 1, 0, 0);
  ctx.fillText(text, probe.actualBoundingBoxLeft * k, probe.actualBoundingBoxAscent * k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.letterSpacing = '0px';
  const data = ctx.getImageData(0, 0, cw, height).data;

  const cells = new Uint8Array(cols * rows);
  for (let sy = 0; sy < rows * 2; sy++) {
    for (let sx = 0; sx < subCols; sx++) {
      const x0 = Math.floor(sx * subW);
      const x1 = Math.min(cw, Math.floor((sx + 1) * subW));
      const y0 = sy * SCALE;
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y0 + SCALE; y += 2) {
        for (let x = x0; x < x1; x++) { sum += data[(y * cw + x) * 4 + 3]!; n++; }
      }
      if (!n || sum / n < 255 * 0.4) continue;
      const bit = (sy % 2 ? 4 : 1) << (sx % 2);
      cells[Math.floor(sy / 2) * cols + Math.floor(sx / 2)]! |= bit;
    }
  }
  return { cols, rows, cells };
}

function line(text: string, family: string, rows: number, aspect: number, squeeze: number): BannerMask | null {
  const key = `${text}\u0000${family}\u0000${rows}\u0000${aspect.toFixed(3)}\u0000${squeeze}`;
  let mask = cache.get(key);
  if (mask === undefined) {
    if (cache.size > 128) cache.clear();
    mask = rasterize(text, family, rows, aspect, squeeze);
    cache.set(key, mask);
  }
  return mask;
}

/** `text` broken into `n` lines at word boundaries, as even as greed allows,
 *  or null when it hasn't the words for it. */
export function splitLines(text: string, n: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (n === 1) return [words.join(' ')];
  if (words.length < n) return null;
  const target = [...words.join(' ')].length / n;
  const lines: string[] = [];
  let cur: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const left = words.length - i;
    const linesLeft = n - lines.length;
    const next = [...cur, words[i]!].join(' ');
    // Break when this word would overshoot the target — or must, so every
    // remaining line still gets a word.
    if (cur.length && (([...next].length > target * 1.15 && linesLeft > 1) || left < linesLeft)) {
      lines.push(cur.join(' '));
      cur = [];
    }
    cur.push(words[i]!);
  }
  lines.push(cur.join(' '));
  return lines.length === n ? lines : null;
}

function stack(parts: BannerMask[]): BannerMask {
  const cols = Math.max(...parts.map(p => p.cols));
  const rows = parts.reduce((n, p) => n + p.rows, 0) + parts.length - 1;
  const cells = new Uint8Array(cols * rows);
  let at = 0;
  for (const p of parts) {
    for (let r = 0; r < p.rows; r++) cells.set(p.cells.subarray(r * p.cols, (r + 1) * p.cols), (at + r) * cols);
    at += p.rows + 1;
  }
  return { cols, rows, cells };
}

/** Condensed faces, tried after the natural one. */
const SQUEEZES = [1, 0.74];

/** The biggest banner of `text` that fits `maxCols` and stands no taller
 *  than two full-size lines: letters `maxRows` tall and shrinking, and at
 *  each size trying more lines and then a condensed face before going
 *  smaller — down to `minRows`, below which a banner stops reading as
 *  letters. Null when nothing fits. */
export function fitBanner(
  text: string, family: string, aspect: number, maxCols: number, maxRows: number, minRows = 3,
): BannerMask | null {
  const maxHeight = maxRows * 2 + 1;
  for (let rows = maxRows; rows >= minRows; rows--) {
    for (const squeeze of SQUEEZES) {
      for (let n = 1; n <= 3; n++) {
        if (n * rows + n - 1 > maxHeight) break;
        const lines = splitLines(text, n);
        if (!lines) break;
        const parts = lines.map(l => line(l, family, rows, aspect, squeeze));
        if (parts.every(p => p && p.cols <= maxCols)) return parts.length === 1 ? parts[0]! : stack(parts as BannerMask[]);
      }
    }
  }
  return null;
}

/* Quadrant bits → glyph. */
const QUADS = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';

/** Stamp a banner at (x, y), with a drop shadow one cell down and right. */
export function drawBanner(
  g: Grid, mask: BannerMask, x: number, y: number, inkOfRow: (r: number) => number, shadow?: number,
): void {
  if (shadow !== undefined) {
    for (let r = 0; r < mask.rows; r++) {
      for (let c = 0; c < mask.cols; c++) if (mask.cells[r * mask.cols + c]) g.set(x + c + 1, y + r + 1, '░', shadow);
    }
  }
  for (let r = 0; r < mask.rows; r++) {
    for (let c = 0; c < mask.cols; c++) {
      const v = mask.cells[r * mask.cols + c]!;
      if (v) g.set(x + c, y + r, QUADS[v]!, inkOfRow(r));
    }
  }
}
