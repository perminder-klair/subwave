// The TTY's colour table. Drawings never name a colour: they name a RAMP and
// an intensity, and the painter resolves the ramp against the live theme. So
// a scene is the same picture in every theme — phosphor on a dark one, a
// teleprinter's ink on a light one — and "more intense" always means further
// from the background, whichever way that is.
//
// Ramps are mixed in OKLab so their steps read as even. The xterm 6×6×6 cube
// follows them for content that brings its own colour (the cover art), which
// is the one palette a real terminal would have used for it.

import { fromOklab, lightness, mix, toOklab, type Rgb, type ThemeRgb } from '@/lib/theme-rgb';

export { lightness, mix, toOklab, type Rgb, type ThemeRgb };

export const INK = 0;
export const INK_STEPS = 10;
export const MUTE = INK + INK_STEPS;
export const MUTE_STEPS = 6;
export const HOT = MUTE + MUTE_STEPS;
export const HOT_STEPS = 12;
export const COOL = HOT + HOT_STEPS;
export const COOL_STEPS = 10;
export const CUBE = COOL + COOL_STEPS;
export const PALETTE_SIZE = CUBE + 216;

const step = (base: number, steps: number, v: number): number =>
  base + Math.max(0, Math.min(steps - 1, Math.round(v * (steps - 1))));

/** bg → ink. */
export const ink = (v: number): number => step(INK, INK_STEPS, v);
/** bg → muted: the theme's quiet tone, for things that must stay back. */
export const mute = (v: number): number => step(MUTE, MUTE_STEPS, v);
/** bg → accent, past it toward ink at the top: embers to a white-hot core. */
export const hot = (v: number): number => step(HOT, HOT_STEPS, v);
/** bg → accent-2 (or the accent's complement), the cold light. */
export const cool = (v: number): number => step(COOL, COOL_STEPS, v);

/** The upper reaches of the two light ramps bloom (AsciiCanvas's glow
 *  layer); everything else is matte. */
export function glows(i: number): boolean {
  return (i >= HOT + 7 && i < HOT + HOT_STEPS) || (i >= COOL + 6 && i < COOL + COOL_STEPS);
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearestLevel(v: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_LEVELS.length; i++) {
    if (Math.abs(CUBE_LEVELS[i]! - v) < Math.abs(CUBE_LEVELS[best]! - v)) best = i;
  }
  return best;
}

/** The xterm-256 cube entry nearest an sRGB colour. */
export function cube(r: number, g: number, b: number): number {
  return CUBE + nearestLevel(r) * 36 + nearestLevel(g) * 6 + nearestLevel(b);
}

export const isDarkTheme = (t: ThemeRgb): boolean => lightness(t.bg) < 0.5;

/** The accent's hue turned by `deg` in OKLCh, lightness and chroma kept. */
function rotateHue(c: Rgb, deg: number): Rgb {
  const [L, A, B] = toOklab(c);
  const r = (deg * Math.PI) / 180;
  return fromOklab([L, A * Math.cos(r) - B * Math.sin(r), A * Math.sin(r) + B * Math.cos(r)]);
}

/** Most themes leave --accent-2 as the accent itself, which would make the
 *  aurora the colour of the fire. Then the cold ramp takes the accent's
 *  complement-ish turn instead, so it still belongs to the theme. */
export function coldLight(t: ThemeRgb): Rgb {
  const [, a1, b1] = toOklab(t.accent);
  const [, a2, b2] = toOklab(t.accent2);
  return Math.hypot(a1 - a2, b1 - b2) < 0.04 ? rotateHue(t.accent, 150) : t.accent2;
}

const hex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;

/** The full table, CSS colour strings indexed as the constants above. */
export function buildPalette(t: ThemeRgb): string[] {
  const out: string[] = [];
  for (let k = 0; k < INK_STEPS; k++) out.push(hex(mix(t.bg, t.ink, 0.13 + 0.87 * (k / (INK_STEPS - 1)))));
  for (let k = 0; k < MUTE_STEPS; k++) out.push(hex(mix(t.bg, t.muted, 0.18 + 0.82 * (k / (MUTE_STEPS - 1)))));
  for (let k = 0; k < HOT_STEPS; k++) {
    out.push(hex(k < 9 ? mix(t.bg, t.accent, 0.16 + 0.84 * (k / 8)) : mix(t.accent, t.ink, (k - 8) * 0.22)));
  }
  const cold = coldLight(t);
  for (let k = 0; k < COOL_STEPS; k++) {
    out.push(hex(k < 8 ? mix(t.bg, cold, 0.16 + 0.84 * (k / 7)) : mix(cold, t.ink, (k - 7) * 0.28)));
  }
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) out.push(hex([CUBE_LEVELS[r]!, CUBE_LEVELS[g]!, CUBE_LEVELS[b]!]));
    }
  }
  return out;
}
