// The character grid every TTY drawing writes into: one code point and one
// palette index per cell. Pure — no DOM — so scenes, instruments and the
// cover can be built and tested in Node; AsciiCanvas is the only painter.
//
// Coordinates are cells and may be fractional or off the grid: writes round
// and clip, so a drawing never has to bounds-check its own maths.

export const SPACE = 32;
/** The right half of a wide (CJK, fullwidth) glyph. The painter skips it;
 *  the glyph in the cell to its left covers both. */
export const WIDE_TAIL = 0;

export type BoxStyle = 'light' | 'heavy' | 'round' | 'double';

const BOX: Record<BoxStyle, string> = {
  // h, v, top-left, top-right, bottom-left, bottom-right
  light: '─│┌┐└┘',
  heavy: '━┃┏┓┗┛',
  round: '─│╭╮╰╯',
  double: '═║╔╗╚╝',
};

/** Terminal cell width of a code point: 2 for East Asian wide and fullwidth
 *  forms (and the emoji blocks), 0 for marks that ride the previous glyph,
 *  else 1. The same rule wcwidth applies, cut down to the ranges a song
 *  title plausibly carries. */
export function cellWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

/** How many cells a string occupies. */
export function textCols(s: string): number {
  let n = 0;
  for (const ch of s.normalize('NFC')) n += cellWidth(ch.codePointAt(0) ?? SPACE);
  return n;
}

/** `s` cut to `cols` cells, ending in an ellipsis when anything was cut. */
export function fitText(s: string, cols: number): string {
  if (cols <= 0) return '';
  const norm = s.normalize('NFC');
  if (textCols(norm) <= cols) return norm;
  let out = '';
  let used = 0;
  for (const ch of norm) {
    const w = cellWidth(ch.codePointAt(0) ?? SPACE);
    if (used + w > cols - 1) break;
    out += ch;
    used += w;
  }
  return out.trimEnd() + '…';
}

/** Greedy word wrap to `cols` cells; a word longer than a line is cut. At
 *  most `maxLines` lines, the last ellipsised when text remains. */
export function wrapText(s: string, cols: number, maxLines = Infinity): string[] {
  const words = s.normalize('NFC').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const next = line ? `${line} ${word}` : word;
    if (textCols(next) <= cols) { line = next; continue; }
    if (line) lines.push(line);
    line = textCols(word) > cols ? fitText(word, cols) : word;
    if (lines.length === maxLines) {
      const last = lines[maxLines - 1]!;
      lines[maxLines - 1] = fitText(`${last} ${words.slice(i).join(' ')}`, cols);
      return lines;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class Grid {
  readonly cols: number;
  readonly rows: number;
  readonly chars: Uint32Array;
  readonly ink: Uint16Array;

  constructor(cols: number, rows: number) {
    this.cols = Math.max(0, Math.floor(cols));
    this.rows = Math.max(0, Math.floor(rows));
    this.chars = new Uint32Array(this.cols * this.rows).fill(SPACE);
    this.ink = new Uint16Array(this.cols * this.rows);
  }

  /** On the grid — and false for NaN, which a drawing's maths can produce. */
  private has(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  clear(): void {
    this.chars.fill(SPACE);
    this.ink.fill(0);
  }

  /** Code point at a cell, or SPACE off the grid. */
  get(x: number, y: number): number {
    const cx = Math.round(x);
    const cy = Math.round(y);
    if (!this.has(cx, cy)) return SPACE;
    return this.chars[cy * this.cols + cx]!;
  }

  /** One narrow glyph. A wide one belongs in text(), which owns the tail. */
  set(x: number, y: number, ch: string | number, ink: number): void {
    const cx = Math.round(x);
    const cy = Math.round(y);
    if (!this.has(cx, cy)) return;
    const i = cy * this.cols + cx;
    // Overwriting either half of a wide glyph orphans the other: blank it.
    if (this.chars[i] === WIDE_TAIL && cx > 0) this.chars[i - 1] = SPACE;
    else if (cx + 1 < this.cols && this.chars[i + 1] === WIDE_TAIL) this.chars[i + 1] = SPACE;
    this.chars[i] = typeof ch === 'number' ? ch : (ch.codePointAt(0) ?? SPACE);
    this.ink[i] = ink;
  }

  /** Write a string from (x, y), clipped to `maxCols` cells and the grid.
   *  Returns the cells consumed. */
  text(x: number, y: number, s: string, ink: number, maxCols = Infinity): number {
    let cx = Math.round(x);
    const cy = Math.round(y);
    const start = cx;
    if (cy < 0 || cy >= this.rows) return 0;
    for (const ch of s.normalize('NFC')) {
      const cp = ch.codePointAt(0) ?? SPACE;
      const w = cellWidth(cp);
      if (w === 0) continue;
      if (cx - start + w > maxCols) break;
      if (w === 2) {
        if (cx + 1 >= 0 && cx < this.cols) {
          this.set(cx, cy, cp, ink);
          this.set(cx + 1, cy, SPACE, ink);
          if (cx + 1 < this.cols && cx >= 0) this.chars[cy * this.cols + cx + 1] = WIDE_TAIL;
        }
      } else {
        this.set(cx, cy, cp, ink);
      }
      cx += w;
    }
    return cx - start;
  }

  fill(x: number, y: number, w: number, h: number, ch: string | number, ink: number): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    for (let yy = y0; yy < y0 + Math.round(h); yy++) {
      for (let xx = x0; xx < x0 + Math.round(w); xx++) this.set(xx, yy, ch, ink);
    }
  }

  /** A frame of box-drawing glyphs; `fillInk` (when given) blanks the inside
   *  so whatever was drawn underneath doesn't show through. */
  box(x: number, y: number, w: number, h: number, ink: number, style: BoxStyle = 'light', fillInk?: number): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = x0 + Math.round(w) - 1;
    const y1 = y0 + Math.round(h) - 1;
    if (x1 <= x0 || y1 <= y0) return;
    const [hz, vt, tl, tr, bl, br] = Array.from(BOX[style]) as [string, string, string, string, string, string];
    if (fillInk !== undefined) this.fill(x0 + 1, y0 + 1, x1 - x0 - 1, y1 - y0 - 1, SPACE, fillInk);
    for (let xx = x0 + 1; xx < x1; xx++) {
      this.set(xx, y0, hz, ink);
      this.set(xx, y1, hz, ink);
    }
    for (let yy = y0 + 1; yy < y1; yy++) {
      this.set(x0, yy, vt, ink);
      this.set(x1, yy, vt, ink);
    }
    this.set(x0, y0, tl, ink);
    this.set(x1, y0, tr, ink);
    this.set(x0, y1, bl, ink);
    this.set(x1, y1, br, ink);
  }
}
