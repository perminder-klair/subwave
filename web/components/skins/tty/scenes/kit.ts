// What every scene shares: the frame it is handed, and the few drawing
// habits that make four landscapes read as one hand.
//
// A scene draws in INTENSITY, never colour (see term/palette.ts): light it
// emits or reflects gets a ramp, and a mass that gives off nothing — a
// treeline, a cliff — is left as the background and read by the texture
// around it. That is what lets one picture work on a dark theme and a light
// one alike.
//
// Focus mode's now-playing card owns the bottom-left of a wide stage, so a
// scene keeps its focal point (the fire, the cabin, the sun, the causeway)
// right of centre. A narrow stage stacks instead (FocusStage), handing the
// scene only the rows above the card.

import { SPACE, type Grid } from '../term/grid';
import type { Signal } from '../term/signal';
import { fbm, hash2 } from '../term/noise';

export type Weather = 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog' | 'storm';

export interface SceneFrame {
  /** Seconds since the stage mounted (frozen when calm). */
  t: number;
  sig: Signal;
  weather: Weather;
}

export type SceneDraw = (g: Grid, f: SceneFrame) => void;

export interface Scene {
  id: SceneId;
  /** What the stage's tag calls it, as a file. */
  file: string;
  /** One line on what it is and what it listens to. */
  blurb: string;
  /** Weather the scene draws itself, so the overlay leaves it alone. */
  ownWeather?: readonly Weather[];
  /** Set up for a grid size; `aspect` is cell width over height, so a
   *  drawing can keep a circle round. Static layers are computed here. */
  build(cols: number, rows: number, aspect: number): SceneDraw;
}

export type SceneId = 'campfire' | 'aurora' | 'sunrise' | 'coast';

export interface Star { x: number; y: number; b: number; ph: number }

/** A fixed scatter of stars over the rows above `horizon`. */
export function scatterStars(cols: number, horizon: number, density: number, seed: number): Star[] {
  const n = Math.round(cols * horizon * density);
  const out: Star[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: Math.floor(hash2(i, 1, seed) * cols),
      y: Math.floor(hash2(i, 2, seed) * horizon),
      b: hash2(i, 3, seed),
      ph: hash2(i, 4, seed) * 6.283,
    });
  }
  return out;
}

/** A star's glyph for brightness `v`, or null when it's too faint to show. */
export function starGlyph(v: number): string | null {
  return v > 0.88 ? '*' : v > 0.66 ? '+' : v > 0.45 ? '•' : v > 0.3 ? '·' : null;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** The 4×4 ordered-dither threshold for a cell, in (0, 1). A gradient drawn
 *  against it comes out as the regular stipple ANSI art used, not as noise. */
export function dither(x: number, y: number): number {
  return (BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16;
}

/** aafire's ramp: flame by character density, sparse to solid. */
export const FIRE = ' .,:;*+%#@';

/** A haze of dots, for glow and mist: never solid, so what's behind it and
 *  what it silhouettes both still read. */
export const HAZE = ' .·:';

/** An ordered-dithered pick between the two ramp glyphs either side of v, so
 *  a smooth gradient comes out as an even mix of them rather than bands.
 *  Dither glyphs, never blocks: ░ cells switched on and off by the matrix
 *  read as a grid of squares, not as a gradient. */
export function ditherGlyph(ramp: string, v: number, x: number, y: number): string {
  const s = Math.max(0, Math.min(1, v)) * (ramp.length - 1);
  const i = Math.floor(s);
  return ramp[Math.min(ramp.length - 1, s - i > dither(x, y) ? i + 1 : i)]!;
}

/** A glyph from a ramp for v in [0, 1]. */
export function rampGlyph(ramp: string, v: number): string {
  return ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(v * (ramp.length - 1))))]!;
}

export interface Pine {
  /** Trunk column. */
  x: number;
  /** The row the trunk stands on. */
  base: number;
  /** Height in rows, tip to base. */
  h: number;
}

/** A row of pines along `base`, small and large mixed, sorted far to near
 *  so drawing them in order overlaps them properly. */
export function plantPines(cols: number, base: number, rows: number, seed: number, from = 0, to = 1): Pine[] {
  const out: Pine[] = [];
  let x = Math.floor(cols * from) + Math.floor(hash2(0, 0, seed) * 4);
  for (let i = 0; x < cols * to; i++) {
    const r = hash2(i, 1, seed);
    out.push({ x, base: base + Math.round(hash2(i, 2, seed) * 2), h: Math.round(rows * (0.07 + r * r * 0.2)) });
    x += 3 + Math.floor(hash2(i, 3, seed) * 7);
  }
  return out.sort((a, b) => a.h - b.h);
}

/** An ASCII pine: tiered ╱╲ flanks over a hollow that clears whatever was
 *  drawn behind it, so a treeline reads against haze or stars alike. */
export function drawPine(g: Grid, p: Pine, aspect: number, edge: number, fill?: number): void {
  const slope = 0.42 / aspect;
  const tiers = Math.max(1, Math.round(p.h / 4));
  const tierH = p.h / tiers;
  for (let r = 0; r < p.h; r++) {
    const y = p.base - p.h + r;
    const tier = Math.floor(r / tierH);
    const into = r - tier * tierH;
    // Each tier starts narrower than the last one ended: the notched flank.
    const half = Math.max(0.5, (tier * tierH * 0.55 + into + 0.6) * slope);
    const l = Math.round(p.x - half);
    const rr = Math.round(p.x + half);
    for (let x = l + 1; x < rr; x++) g.set(x, y, fill === undefined ? SPACE : '▒', fill ?? 0);
    if (r === 0) { g.set(p.x, y, '▲', edge); continue; }
    g.set(l, y, '╱', edge);
    g.set(rr, y, '╲', edge);
  }
  g.set(p.x, p.base, '│', edge);
}

/** Thin strokes at seven heights down a cell, top to bottom. */
const SCAN = '▔⎺⎻─⎼⎽▁';

/** A skyline's outline, drawn as a line. `top[x]` is where the skyline
 *  crosses column x, in rows and fractional: a gentle slope steps through
 *  the scan-line strokes a fraction of a row at a time, the way a VT100
 *  drew a graph; a steep one is ╱ or ╲, with a │ down any drop of more than
 *  a row. */
export function drawCrest(g: Grid, top: ArrayLike<number>, ink: number, from = 0, to = top.length): void {
  for (let x = from; x < to; x++) {
    const y = top[x]!;
    const next = x + 1 < top.length ? top[x + 1]! : y;
    const d = next - y;
    if (Math.abs(d) <= 0.75) {
      const mid = (y + next) / 2;
      const row = Math.floor(mid);
      g.set(x, row, SCAN[Math.min(6, Math.round((mid - row) * 6))]!, ink);
    } else if (d < 0) {
      const row = Math.floor(y - 0.5);
      g.set(x, row, '╱', ink);
      for (let k = Math.floor(next) + 1; k < row; k++) g.set(x + 1, k, '│', ink);
    } else {
      const row = Math.floor(y + 0.5);
      g.set(x, row, '╲', ink);
      for (let k = row + 1; k <= Math.floor(next) - 1; k++) g.set(x, k, '│', ink);
    }
  }
}

/** Ridged noise in [0, 1]: sharp crests rather than fbm's rounded hills. */
export function ridged(x: number, y: number, seed: number): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < 4; i++) {
    const n = 1 - Math.abs(fbm(x * f, y * f, 1, seed + i * 13) * 2 - 1);
    v += amp * n * n;
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return v / norm;
}

/** A disc at half-cell vertical resolution (▀ ▄ █), so it reads round. */
export function drawDisc(g: Grid, cx: number, cy: number, r: number, aspect: number, ink: number): void {
  for (let y = Math.floor(cy - r) - 1; y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r / aspect) - 1; x <= cx + r / aspect + 1; x++) {
      const dx = (x + 0.5 - cx) * aspect;
      const up = Math.hypot(dx, y + 0.25 - cy) < r;
      const down = Math.hypot(dx, y + 0.75 - cy) < r;
      if (up || down) g.set(x, y, up && down ? '█' : up ? '▀' : '▄', ink);
    }
  }
}
