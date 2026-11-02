// How one cell's glyph is put on a canvas. Block elements, box drawing and
// braille are drawn as geometry rather than taken from the font — what kitty
// and wezterm do — because a theme's mono face sets its own line height and
// side bearings: font-drawn █ rows leave seams, ─ runs leave gaps, and braille
// often isn't in the face at all. Everything else is the font's own glyph.

export interface GlyphMetrics {
  /** Cell size in device pixels (integers). */
  w: number;
  h: number;
  /** The canvas font string, already in device pixels. */
  font: string;
  /** Alphabetic baseline from the cell's top, device pixels. */
  baseline: number;
  /** One stroke, device pixels. */
  stroke: number;
}

/* Arms of the single-weight box glyphs: up, right, down, left — 1 light,
   2 heavy. */
const ARMS = new Map<number, readonly [number, number, number, number]>([
  [0x2500, [0, 1, 0, 1]], [0x2501, [0, 2, 0, 2]], [0x2502, [1, 0, 1, 0]], [0x2503, [2, 0, 2, 0]],
  [0x250c, [0, 1, 1, 0]], [0x250f, [0, 2, 2, 0]], [0x2510, [0, 0, 1, 1]], [0x2513, [0, 0, 2, 2]],
  [0x2514, [1, 1, 0, 0]], [0x2517, [2, 2, 0, 0]], [0x2518, [1, 0, 0, 1]], [0x251b, [2, 0, 0, 2]],
  [0x251c, [1, 1, 1, 0]], [0x2523, [2, 2, 2, 0]], [0x2524, [1, 0, 1, 1]], [0x252b, [2, 0, 2, 2]],
  [0x252c, [0, 1, 1, 1]], [0x2533, [0, 2, 2, 2]], [0x2534, [1, 1, 0, 1]], [0x253b, [2, 2, 0, 2]],
  [0x253c, [1, 1, 1, 1]], [0x254b, [2, 2, 2, 2]],
  [0x2574, [0, 0, 0, 1]], [0x2575, [1, 0, 0, 0]], [0x2576, [0, 1, 0, 0]], [0x2577, [0, 0, 1, 0]],
  [0x2578, [0, 0, 0, 2]], [0x2579, [2, 0, 0, 0]], [0x257a, [0, 2, 0, 0]], [0x257b, [0, 0, 2, 0]],
  [0x257c, [0, 2, 0, 1]], [0x257d, [1, 0, 2, 0]], [0x257e, [0, 1, 0, 2]], [0x257f, [2, 0, 1, 0]],
]);

/* Dashed runs: [vertical, heavy, dashes]. */
const DASHES = new Map<number, readonly [boolean, boolean, number]>([
  [0x2504, [false, false, 3]], [0x2505, [false, true, 3]], [0x2506, [true, false, 3]], [0x2507, [true, true, 3]],
  [0x2508, [false, false, 4]], [0x2509, [false, true, 4]], [0x250a, [true, false, 4]], [0x250b, [true, true, 4]],
  [0x254c, [false, false, 2]], [0x254d, [false, true, 2]], [0x254e, [true, false, 2]], [0x254f, [true, true, 2]],
]);

/* Braille dot bits → (column, row) in the 2×4 cell. */
const BRAILLE_DOTS: ReadonlyArray<readonly [number, number, number]> = [
  [0x01, 0, 0], [0x02, 0, 1], [0x04, 0, 2], [0x40, 0, 3],
  [0x08, 1, 0], [0x10, 1, 1], [0x20, 1, 2], [0x80, 1, 3],
];

/* Quadrant blocks ▖▗▘▙▚▛▜▝▞▟ as UL, UR, LL, LR bits. */
const QUADS: Record<number, number> = {
  0x2596: 0b0010, 0x2597: 0b0001, 0x2598: 0b1000, 0x2599: 0b1011, 0x259a: 0b1001,
  0x259b: 0b1110, 0x259c: 0b1101, 0x259d: 0b0100, 0x259e: 0b0110, 0x259f: 0b0111,
};

/** Draws `cp` with its top-left at (x, y). Returns false when it isn't one of
 *  the geometric glyphs, so the caller falls back to the font. */
function drawGeometric(ctx: CanvasRenderingContext2D, cp: number, x: number, y: number, m: GlyphMetrics): boolean {
  const { w, h, stroke } = m;
  const cx = x + Math.floor(w / 2);
  const cy = y + Math.floor(h / 2);
  const rect = (rx: number, ry: number, rw: number, rh: number) =>
    ctx.fillRect(Math.round(rx), Math.round(ry), Math.max(1, Math.round(rw)), Math.max(1, Math.round(rh)));

  // ▀ ▁…▇ █ ▉…▏ ▐ ▔ ▕ and the quadrants.
  if (cp >= 0x2580 && cp <= 0x259f) {
    if (cp === 0x2580) { rect(x, y, w, h / 2); return true; }
    if (cp >= 0x2581 && cp <= 0x2588) {
      const n = cp - 0x2580;
      const top = Math.round(h * (1 - n / 8));
      rect(x, y + top, w, h - top);
      return true;
    }
    if (cp >= 0x2589 && cp <= 0x258f) { rect(x, y, (w * (8 - (cp - 0x2588))) / 8, h); return true; }
    if (cp === 0x2590) { rect(x + w / 2, y, w - Math.floor(w / 2), h); return true; }
    if (cp === 0x2594) { rect(x, y, w, h / 8); return true; }
    if (cp === 0x2595) { rect(x + w - w / 8, y, w / 8, h); return true; }
    if (cp >= 0x2591 && cp <= 0x2593) {
      // Shades as a dot stipple, the way a terminal draws them: 25/50/75%.
      const p = Math.max(1, Math.round(stroke));
      for (let j = 0; j * p < h; j++) {
        for (let i = 0; i * p < w; i++) {
          const on = cp === 0x2591 ? i % 2 === 0 && j % 2 === 0
            : cp === 0x2592 ? (i + j) % 2 === 0
            : !(i % 2 === 1 && j % 2 === 1);
          if (on) ctx.fillRect(x + i * p, y + j * p, Math.min(p, w - i * p), Math.min(p, h - j * p));
        }
      }
      return true;
    }
    const q = QUADS[cp];
    if (q !== undefined) {
      const hw = Math.floor(w / 2);
      const hh = Math.floor(h / 2);
      if (q & 0b1000) rect(x, y, hw, hh);
      if (q & 0b0100) rect(x + hw, y, w - hw, hh);
      if (q & 0b0010) rect(x, y + hh, hw, h - hh);
      if (q & 0b0001) rect(x + hw, y + hh, w - hw, h - hh);
      return true;
    }
    return false;
  }

  const arms = ARMS.get(cp);
  if (arms) {
    const [up, right, down, left] = arms;
    const t = (wt: number) => (wt === 2 ? stroke * 2 : stroke);
    // Each arm runs from the far edge to the centre, overlapping by half the
    // widest crossing stroke so corners close.
    const hx = Math.max(t(up), t(down)) / 2;
    const hy = Math.max(t(left), t(right)) / 2;
    if (up) rect(cx - t(up) / 2, y, t(up), cy - y + hy);
    if (down) rect(cx - t(down) / 2, cy - hy, t(down), y + h - cy + hy);
    if (left) rect(x, cy - t(left) / 2, cx - x + hx, t(left));
    if (right) rect(cx - hx, cy - t(right) / 2, x + w - cx + hx, t(right));
    return true;
  }

  const dash = DASHES.get(cp);
  if (dash) {
    const [vertical, heavy, n] = dash;
    const t = heavy ? stroke * 2 : stroke;
    const len = vertical ? h : w;
    const seg = len / n;
    for (let i = 0; i < n; i++) {
      if (vertical) rect(cx - t / 2, y + i * seg + seg * 0.15, t, seg * 0.7);
      else rect(x + i * seg + seg * 0.15, cy - t / 2, seg * 0.7, t);
    }
    return true;
  }

  // ⎺ ⎻ ⎼ ⎽: the VT100's horizontal scan lines, a stroke at 1/8, 3/8, 5/8
  // and 7/8 of the cell — with ▔ ─ ▁ they draw a line graph smooth to a
  // fraction of a row.
  if (cp >= 0x23ba && cp <= 0x23bd) {
    const at = [0.14, 0.36, 0.64, 0.86][cp - 0x23ba]!;
    rect(x, y + Math.round(h * at - stroke / 2), w, stroke);
    return true;
  }

  // ═ ║ ╔ ╗ ╚ ╝: two strokes either side of the centre line.
  if (cp === 0x2550 || cp === 0x2551 || cp === 0x2554 || cp === 0x2557 || cp === 0x255a || cp === 0x255d) {
    const t = stroke;
    const d = Math.max(t * 1.5, Math.round(Math.min(w, h) / 7));
    const H = (yy: number, x0: number, x1: number) => rect(x0, yy - t / 2, x1 - x0, t);
    const V = (xx: number, y0: number, y1: number) => rect(xx - t / 2, y0, t, y1 - y0);
    const L = x;
    const R = x + w;
    const T = y;
    const B = y + h;
    switch (cp) {
      case 0x2550: H(cy - d, L, R); H(cy + d, L, R); break;
      case 0x2551: V(cx - d, T, B); V(cx + d, T, B); break;
      case 0x2554: H(cy - d, cx - d, R); V(cx - d, cy - d, B); H(cy + d, cx + d, R); V(cx + d, cy + d, B); break;
      case 0x2557: H(cy - d, L, cx + d); V(cx + d, cy - d, B); H(cy + d, L, cx - d); V(cx - d, cy + d, B); break;
      case 0x255a: V(cx - d, T, cy + d); H(cy + d, cx - d, R); V(cx + d, T, cy - d); H(cy - d, cx + d, R); break;
      case 0x255d: V(cx + d, T, cy + d); H(cy + d, L, cx + d); V(cx - d, T, cy - d); H(cy - d, L, cx - d); break;
    }
    return true;
  }

  // ╭ ╮ ╯ ╰: a straight run into a true arc.
  if (cp >= 0x256d && cp <= 0x2570) {
    const r = Math.min(w, h) / 2;
    const [ex, ey] = cp === 0x256d || cp === 0x2570 ? [x + w, cy] : [x, cy];
    const vy = cp === 0x256d || cp === 0x256e ? y + h : y;
    ctx.save();
    ctx.lineWidth = stroke;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.arcTo(cx, cy, cx, vy, r);
    ctx.lineTo(cx, vy);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  // ╱ ╲ ╳ corner to corner, so a run of them joins up across cells.
  if (cp >= 0x2571 && cp <= 0x2573) {
    ctx.save();
    ctx.lineWidth = stroke;
    ctx.beginPath();
    if (cp !== 0x2572) { ctx.moveTo(x, y + h); ctx.lineTo(x + w, y); }
    if (cp !== 0x2571) { ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); }
    ctx.stroke();
    ctx.restore();
    return true;
  }

  if (cp >= 0x2800 && cp <= 0x28ff) {
    const bits = cp - 0x2800;
    if (!bits) return true;
    const r = Math.max(stroke * 0.75, Math.min(w / 5.5, h / 11));
    ctx.beginPath();
    for (const [bit, col, row] of BRAILLE_DOTS) {
      if (!(bits & bit)) continue;
      const dx = x + w * (col === 0 ? 0.3 : 0.7);
      const dy = y + h * (0.14 + row * 0.24);
      ctx.moveTo(dx + r, dy);
      ctx.arc(dx, dy, r, 0, Math.PI * 2);
    }
    ctx.fill();
    return true;
  }

  return false;
}

/** Draw one glyph in `color` with its cell's top-left at (x, y). */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  m: GlyphMetrics,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (drawGeometric(ctx, cp, x, y, m)) return;
  ctx.font = m.font;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String.fromCodePoint(cp), x, y + m.baseline);
}
