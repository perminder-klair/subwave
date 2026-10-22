// The theme's colour tokens as sRGB bytes, for drawings CSS can't colour: a
// canvas or a WebGL scene needs numbers, not var(). lib/theme writes every
// token onto <html>, so a token is read from there (or from an element that
// inherits it), and `watchTheme` fires on every switch: the provider's
// attribute writes, and the system dark-mode flip a station may follow.
//
// Mixing is in OKLab, so a ramp's steps read as even.

export type Rgb = readonly [number, number, number];

export interface ThemeRgb {
  bg: Rgb;
  ink: Rgb;
  muted: Rgb;
  accent: Rgb;
  accent2: Rgb;
}

/** Classic Dark, for a token that is missing or unparseable. */
export const THEME_RGB_FALLBACK: ThemeRgb = {
  bg: [16, 14, 12],
  ink: [236, 230, 220],
  muted: [193, 192, 189],
  accent: [217, 75, 42],
  accent2: [217, 75, 42],
};

/** Any CSS colour (hex, oklch, color-mix…) to sRGB bytes, by painting it. */
export function resolveCssColor(probe: CanvasRenderingContext2D, css: string, fallback: Rgb): Rgb {
  if (!css) return fallback;
  const sentinel = `rgb(${fallback.join(',')})`;
  probe.fillStyle = sentinel;
  probe.fillStyle = css;
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
}

/** A 1×1 canvas for resolveCssColor; null where a 2D context is unavailable. */
export function createColorProbe(): CanvasRenderingContext2D | null {
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (probe) probe.canvas.width = probe.canvas.height = 1;
  return probe;
}

/** The theme tokens as `el` inherits them. */
export function readThemeRgb(el: Element, probe: CanvasRenderingContext2D): ThemeRgb {
  const cs = getComputedStyle(el);
  const get = (k: string) => cs.getPropertyValue(k).trim();
  const F = THEME_RGB_FALLBACK;
  const accent = resolveCssColor(probe, get('--accent'), F.accent);
  return {
    bg: resolveCssColor(probe, get('--bg'), F.bg),
    ink: resolveCssColor(probe, get('--ink'), F.ink),
    muted: resolveCssColor(probe, get('--muted'), F.muted),
    accent,
    accent2: resolveCssColor(probe, get('--accent-2'), accent),
  };
}

const THEME_KEYS = ['bg', 'ink', 'muted', 'accent', 'accent2'] as const;

/** The same colours in both readings. */
export function sameThemeRgb(a: ThemeRgb, b: ThemeRgb): boolean {
  return THEME_KEYS.every(k => a[k][0] === b[k][0] && a[k][1] === b[k][1] && a[k][2] === b[k][2]);
}

/** Calls `onChange` whenever the theme may have changed; returns the
 *  unsubscribe. "May": any write to those attributes fires it, colours
 *  changed or not, so a reader with real work to redo compares its new
 *  reading first (sameThemeRgb). The dedupe can't live here — each reader
 *  reads from its own element, where a subtree may re-declare the tokens. */
export function watchTheme(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', onChange);
  return () => {
    mo.disconnect();
    mq.removeEventListener('change', onChange);
  };
}

/* ── OKLab ─────────────────────────────────────────────────────────── */

type Lab = [number, number, number];

const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const fromLinear = (c: number): number => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
};

export function toOklab([r8, g8, b8]: Rgb): Lab {
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function fromOklab([L, A, B]: Lab): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const la = toOklab(a);
  const lb = toOklab(b);
  return fromOklab([la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t]);
}

/** Relative lightness in [0, 1] (OKLab L). */
export const lightness = (c: Rgb): number => toOklab(c)[0];
