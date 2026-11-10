// campfire.ans — a fire in a clearing under the milky way, a tent catching
// its light. The flames stand taller on the bass, the sparks thicken as the
// track gets louder, and the brightest stars flare on the beat.
//
// The fire sits right of centre: focus mode's card takes the bottom-left.

import { clamp, fbm, hash2, noise2 } from '../term/noise';
import { cool, hot, ink, mute } from '../term/palette';
import { FIRE, HAZE, ditherGlyph, drawPine, plantPines, rampGlyph, scatterStars, starGlyph, type Scene } from './kit';

/** Milky way dust by density: a haze of dots thickening into stipple. */
const DUST = ' .·:░';
/** The firelit ground: warm grit, thickest at the fire. */
const GRIT = ' .,:;+';

export const campfire: Scene = {
  id: 'campfire',
  file: 'campfire.ans',
  blurb: 'a fire under the milky way: flames on the bass, sparks on the hits',
  build(cols, rows, aspect) {
    const hz = Math.round(rows * 0.6);
    const fx = Math.round(cols * 0.66);
    const fy = rows - Math.max(3, Math.round(rows * 0.16));
    const stars = scatterStars(cols, hz, 0.03, 41);

    // The treeline round the clearing, with a gap where the fire is.
    const pines = [
      ...plantPines(cols, hz, rows, 5, 0, 0.55),
      ...plantPines(cols, hz - 1, rows, 6, 0.78, 1),
    ];

    // The milky way leans across the sky; dark lanes cut along it.
    const dust = new Float32Array(cols * hz);
    for (let y = 0; y < hz; y++) {
      for (let x = 0; x < cols; x++) {
        const u = x / cols;
        const d = (y / hz - (0.85 - u * 0.75)) / 0.16;
        const lane = fbm(x * 0.08, y * 0.35, 3, 9) > 0.62 && Math.abs(d) < 0.5 ? 0.25 : 1;
        dust[y * cols + x] = Math.exp(-d * d) * (0.25 + fbm(x * 0.07, y * 0.22, 4, 3) * 0.95) * lane;
      }
    }

    const tx = Math.round(cols * 0.86);
    const tentH = Math.max(4, Math.round(rows * 0.2));
    const tentBase = fy + 1;
    const tentTop = tentBase - tentH;

    return (g, { t, sig }) => {
      const loud = sig.active ? sig.level : 0;
      const flick = 0.85 + 0.12 * Math.sin(t * 13) * Math.sin(t * 7.3) + loud * 0.2;

      for (let y = 0; y < hz; y++) {
        // Airglow thickening toward the trees, so their tops cut against it.
        const glow = Math.pow(clamp((y - hz * 0.3) / (hz * 0.7)), 1.5);
        for (let x = 0; x < cols; x++) {
          const v = dust[y * cols + x]!;
          if (v > 0.3) g.set(x, y, ditherGlyph(DUST, (v - 0.25) * 1.15, x, y), cool(0.12 + v * 0.5));
          else if (glow > 0.05) {
            const ch = ditherGlyph(HAZE, glow, x, y);
            if (ch !== ' ') g.set(x, y, ch, mute(0.05 + glow * 0.35));
          }
        }
      }
      for (const s of stars) {
        if (dust[s.y * cols + s.x]! > 0.55) continue;
        const v = s.b * 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.2 + s.ph)) + (s.b > 0.85 ? sig.beat * 0.25 : 0);
        const ch = starGlyph(v);
        if (ch) g.set(s.x, s.y, ch, v > 0.92 ? cool(1) : ink(0.2 + v * 0.7));
      }

      for (const p of pines) drawPine(g, p, aspect, ink(0.22 + (p.h / rows) * 0.6));

      // The clearing: firelight falling off in a dithered pool; beyond it,
      // dark ground with the odd tuft.
      for (let y = hz; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const d = Math.hypot((x - fx) * aspect, (y - fy) * 2) / (rows * 0.3);
          const v = Math.exp(-d * 1.8) * flick;
          const ch = ditherGlyph(GRIT, v * 1.1, x, y);
          if (ch !== ' ') g.set(x, y, ch, hot(0.15 + v * 0.55));
          else if (hash2(x, y, 7) > 0.94) g.set(x, y, hash2(x, y, 8) > 0.5 ? ',' : '.', ink(0.1));
        }
      }

      // The tent, its fire-facing (left) side lit.
      for (let y = tentTop; y <= tentBase; y++) {
        const hw = ((y - tentTop) * 0.62) / aspect;
        for (let x = Math.round(tx - hw); x <= Math.round(tx + hw); x++) {
          const side = (x - tx) / Math.max(1, hw);
          const lit = clamp(0.3 + (0.5 - side * 0.5) * 0.55 * flick);
          const door = Math.abs(x - tx) < ((y - tentTop) * 0.22) / aspect && y > tentBase - tentH * 0.55;
          if (side < -0.85) g.set(x, y, '╱', hot(lit + 0.3));
          else if (side > 0.85) g.set(x, y, '╲', ink(0.35));
          else if (door) g.set(x, y, '▒', hot(0.08));
          else g.set(x, y, lit > 0.55 ? '▓' : '▒', hot(lit * 0.75));
        }
      }
      g.set(tx, tentTop - 1, '╿', ink(0.45));

      // Logs and a ring of stones.
      g.text(fx - 4, fy + 1, '▄▄▀██▀▄▄', ink(0.3));
      for (let k = -6; k <= 6; k += 2) g.set(fx + k, fy + 2, 'o', mute(0.35 + (6 - Math.abs(k)) * 0.06));

      // The flames, aafire-style: a noisy teardrop drawn by glyph density,
      // standing taller on the bass.
      const flameH = rows * 0.3 * (0.6 + (sig.active ? sig.bass * 0.7 + sig.beat * 0.12 : 0.08));
      const baseW = (rows * 0.2) / aspect;
      for (let y = Math.ceil(fy - flameH); y <= fy; y++) {
        const h = (fy + 1 - y) / flameH;
        if (h > 1) continue;
        const width = baseW * Math.pow(1 - h, 0.65) + 0.6;
        const sway = Math.sin(t * 3 + y * 0.4) * h * 1.6;
        for (let x = Math.floor(fx - baseW - 2); x <= Math.ceil(fx + baseW + 2); x++) {
          const n = noise2(x * 0.5, y * 0.45 + t * 6, 3) * 0.6 + noise2(x * 1.1, y * 0.9 + t * 9, 8) * 0.4;
          // Tongues: the edge licks in and out, more so higher up.
          const lick = Math.sin((x - fx) * 0.8 + t * 4 + y * 0.35) * h * 0.3;
          const e = 1 - Math.abs(x - fx - sway) / width + lick;
          const v = e * 1.15 - h * 0.45 + (n - 0.5) * 1.0;
          if (v > 0.04) g.set(x, y, rampGlyph(FIRE, clamp(v)), hot(clamp(0.3 + v * 0.8 * flick)));
        }
      }

      // Sparks climbing toward the stars; more of them as it gets louder.
      const sparks = Math.round(10 + loud * 40);
      for (let i = 0; i < sparks; i++) {
        const sp = 0.6 + hash2(i, 1, 21);
        const life = (t * 0.3 * sp * (0.8 + loud) + hash2(i, 2, 21)) % 1;
        const ph = hash2(i, 3, 21) * 6.283;
        const drift = (hash2(i, 4, 21) - 0.5) * life * cols * 0.1;
        const x = fx + Math.sin(ph + t * 1.4) * (1 + life * 4) + drift;
        const y = fy - flameH * 0.7 - life * (fy - flameH - rows * 0.06);
        if (Math.sin(t * 19 + ph * 7) < -0.4) continue;
        g.set(x, y, life < 0.25 ? '*' : life < 0.6 ? '+' : '.', hot(clamp(0.95 - life * 0.6)));
      }
    };
  },
};
