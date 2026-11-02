// The station's actual weather, laid over whichever scene is up: rain,
// snow, fog, cloud, and a storm whose lightning strikes on the music's
// hardest hits. Drawn last, over the scene, and stateless — every drop's
// place is a function of time, so a still frame is just as wet.

import type { Grid } from '../term/grid';
import { fbm, hash2 } from '../term/noise';
import { cool, ink } from '../term/palette';
import { ditherGlyph, type SceneFrame, type Weather } from './kit';

const SKY_GLYPHS = new Set([32, 0xb7, 0x2e, 0x3a, 0x2022, 0x2b, 0x2a]);

function rain(g: Grid, t: number, heavy: boolean): void {
  const n = Math.round(g.cols * g.rows * (heavy ? 0.05 : 0.032));
  for (let i = 0; i < n; i++) {
    const near = hash2(i, 1, 31) > 0.55;
    const speed = near ? 36 : 24;
    const y = ((hash2(i, 2, 31) * (g.rows + 6) + t * speed) % (g.rows + 6)) - 3;
    const x = (hash2(i, 3, 31) * g.cols + y * 0.2) % g.cols;
    g.set(x, y, near ? '│' : '╎', near ? cool(0.75) : cool(0.45));
    g.set(x - 0.2, y - 1, '╎', near ? cool(0.45) : cool(0.25));
  }
}

function snow(g: Grid, t: number): void {
  const n = Math.round(g.cols * g.rows * 0.014);
  for (let i = 0; i < n; i++) {
    const depth = hash2(i, 1, 37);
    const speed = 1.5 + depth * 4;
    const y = (hash2(i, 2, 37) * g.rows + t * speed) % g.rows;
    const x = (hash2(i, 3, 37) * g.cols + Math.sin(t * 0.7 + i) * 1.5 + t * 0.8) % g.cols;
    g.set(x, y, depth > 0.75 ? '*' : depth > 0.4 ? '•' : '·', ink(0.45 + depth * 0.5));
  }
}

/** Wisps drifting low across the scene: thin where they show the scene
 *  through, solid only at their hearts. */
function fog(g: Grid, t: number): void {
  for (let y = Math.floor(g.rows * 0.3); y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const f = fbm(x * 0.025 + t * 0.06, y * 0.3, 3, 77) + (y / g.rows) * 0.12 - 0.5;
      if (f <= 0.04) continue;
      const ch = ditherGlyph(' .-~═', f * 4, x, y);
      if (ch !== ' ' && (f > 0.16 || g.get(x, y) === 32)) g.set(x, y, ch, ink(0.25 + f));
    }
  }
}

/** Cloud over the upper sky. Thin cloud only fills sky; a dense heart
 *  covers whatever it crosses, sun included — overcast is overcast. */
function clouds(g: Grid, t: number, cover: number): void {
  for (let y = 0; y < Math.floor(g.rows * 0.45); y++) {
    for (let x = 0; x < g.cols; x++) {
      const c = fbm(x * 0.03 + t * 0.02, y * 0.17, 4, 55) - y / (g.rows * 3) + cover;
      if (c <= 0.5) continue;
      const heart = c > 0.62;
      if (!heart && !SKY_GLYPHS.has(g.get(x, y))) continue;
      g.set(x, y, ditherGlyph(' .·:░', (c - 0.5) * 4, x, y), ink(0.2 + (c - 0.5) * 1.2));
    }
  }
}

/** A forked bolt from the top of the sky, alive for a few frames after a
 *  hard hit — and now and then on its own, so a quiet storm still flashes. */
function lightning(g: Grid, f: SceneFrame): void {
  const beat = Math.floor(f.t * 0.6);
  const own = (f.t * 0.6) % 1 < 0.05 && hash2(beat, 0, 43) > 0.55;
  if (!(f.sig.active && f.sig.onset > 0.55) && !own) return;
  let x = Math.floor(hash2(own ? beat : Math.floor(f.t * 4), 1, 43) * g.cols);
  const len = g.rows * (0.35 + hash2(beat, 2, 43) * 0.25);
  for (let y = 0; y < len; y++) {
    const step = Math.floor(hash2(x, y, 44) * 3) - 1;
    g.set(x, y, step < 0 ? '╱' : step > 0 ? '╲' : '│', ink(1));
    x += step;
    if (hash2(x, y, 45) > 0.93) {
      for (let k = 1; k < 4; k++) g.set(x + k, y + k, '╲', cool(0.9));
    }
  }
}

export function drawWeather(g: Grid, f: SceneFrame, own: readonly Weather[] = []): void {
  if (own.includes(f.weather)) return;
  switch (f.weather) {
    case 'rain': clouds(g, f.t, 0.08); rain(g, f.t, false); break;
    case 'storm': clouds(g, f.t, 0.14); rain(g, f.t, true); lightning(g, f); break;
    case 'snow': clouds(g, f.t, 0); snow(g, f.t); break;
    case 'fog': fog(g, f.t); break;
    case 'cloudy': clouds(g, f.t, 0.05); break;
    default: break;
  }
}
