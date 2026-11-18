/* The galaxy's colours, derived from the live theme. The map is always night,
   because bloom needs a dark ground, so the theme's darker colour becomes the
   sky and its lighter one the starlight: on a light theme the night comes from
   the ink and the stars from the paper, on a dark theme the other way round.

   A star's colour is a tone (data.ts nodeTone): 0 is a quiet star, 1 is the
   accent, and null is an unmeasured one, drawn as a hollow ring in the faint
   colour. The fractions below put Classic exactly where its hand-picked
   palette was, and every other theme at the same distances in its own hues. */

import { fromOklab, mix, toOklab, type Rgb, type ThemeRgb } from '@/lib/theme-rgb';

export interface GalaxyPalette {
  night: Rgb;
  /** The starlight every quiet tone is mixed from. */
  light: Rgb;
  /** Tone 0. */
  quiet: Rgb;
  /** Tone 1: the accent. */
  hot: Rgb;
  /** Unmeasured: hollow rings, and the legend's "not measured" key. */
  faint: Rgb;
  /** Scene names, behind the stars. */
  sceneLabel: Rgb;
  /** Track titles, in front of them. */
  trackLabel: Rgb;
}

// OKLab lightness bounds. A themed sky darker than this keeps its own depth;
// a brighter one (Blueprint's blue, Riso's ink) is taken down to it.
const NIGHT_MAX_L = 0.15;
// Starlight and the accent are lifted to these, so a custom theme with a dim
// paper or a dark accent still draws a visible sky.
const LIGHT_MIN_L = 0.8;
const HOT_MIN_L = 0.58;
// The nebula is additive and bloom keys off brightness, so a pale accent
// (Phosphor's amber, Blueprint's sky) would wash whole clusters out and bury
// the scene names. Held near Classic's vermilion, every theme glows alike.
const HOT_MAX_L = 0.66;

// How far from night toward the starlight each tone sits.
const QUIET_AT = 0.42;
const FAINT_AT = 0.65;
const SCENE_LABEL_AT = 0.59;
const TRACK_LABEL_AT = 0.85;

/** `c` with its OKLab lightness clamped to [minL, maxL]. A darkened colour
 *  loses chroma in step, so a bright blue sky turns navy rather than neon. */
function clampLightness(c: Rgb, minL: number, maxL: number): Rgb {
  const [L, A, B] = toOklab(c);
  if (L > maxL) return fromOklab([maxL, (A * maxL) / L, (B * maxL) / L]);
  if (L < minL) return fromOklab([minL, A, B]);
  return c;
}

export function galaxyPalette(theme: ThemeRgb): GalaxyPalette {
  const bgL = toOklab(theme.bg)[0];
  const inkL = toOklab(theme.ink)[0];
  const [dark, bright] = bgL <= inkL ? [theme.bg, theme.ink] : [theme.ink, theme.bg];
  const night = clampLightness(dark, 0, NIGHT_MAX_L);
  const light = clampLightness(bright, LIGHT_MIN_L, 1);
  return {
    night,
    light,
    quiet: mix(night, light, QUIET_AT),
    hot: clampLightness(theme.accent, HOT_MIN_L, HOT_MAX_L),
    faint: mix(night, light, FAINT_AT),
    sceneLabel: mix(night, light, SCENE_LABEL_AT),
    trackLabel: mix(night, light, TRACK_LABEL_AT),
  };
}

/** A tone's colour: quiet → hot along the ramp, or faint for null. */
export function toneRgb(p: GalaxyPalette, tone: number | null): Rgb {
  if (tone == null) return p.faint;
  return mix(p.quiet, p.hot, Math.max(0, Math.min(1, tone)));
}

export const rgbCss = ([r, g, b]: Rgb): string => `rgb(${r},${g},${b})`;

/** The legend's ramp bar, stopped often enough to follow the OKLab curve. */
export function rampGradient(p: GalaxyPalette): string {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => rgbCss(toneRgb(p, t)));
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

export function samePalette(a: GalaxyPalette, b: GalaxyPalette): boolean {
  return (Object.keys(a) as (keyof GalaxyPalette)[]).every((k) => a[k].every((v, i) => v === b[k][i]));
}
