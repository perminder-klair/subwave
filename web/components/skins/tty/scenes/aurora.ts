// aurora.ans — a log cabin in the snow, its windows lit, under the northern
// lights. The aurora's hem traces the spectrum as it plays, its curtains
// brighten with the mids and flare on the beat, and the snow never stops.

import { clamp, fbm, hash2, noise2 } from '../term/noise';
import { cool, hot, ink, mute } from '../term/palette';
import { bandAt } from '../term/signal';
import { ditherGlyph, drawCrest, drawPine, plantPines, ridged, scatterStars, starGlyph, type Scene } from './kit';

/** A curtain ray by brightness: faint dashes to a doubled line. */
const RAY = ' ╎│┃║';
const SNOW = ' .·:░';

export const aurora: Scene = {
  id: 'aurora',
  file: 'aurora.ans',
  blurb: 'a cabin under the northern lights: the hem traces the spectrum, curtains flare on the beat',
  ownWeather: ['snow'],
  build(cols, rows, aspect) {
    const hz = Math.round(rows * 0.6);
    const stars = scatterStars(cols, hz, 0.02, 77);

    // Snow-capped ridges along the horizon.
    const ridge = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      ridge[x] = hz - rows * (0.02 + Math.pow(ridged(x * 0.028, 3.3, 13), 1.6) * 0.34);
    }

    // The cabin: right of centre, standing in the snow.
    const cw = Math.max(14, Math.round((rows * 0.55) / aspect));
    const cx = Math.round(cols * 0.74 - cw / 2);
    const floor = Math.round(rows * 0.86);
    const wallH = Math.max(3, Math.round(rows * 0.12));
    const roofH = Math.max(3, Math.round(rows * 0.13));
    const wallTop = floor - wallH;
    const pines = [
      ...plantPines(cols, Math.round(rows * 0.8), rows * 1.1, 17, 0.5, cx / cols - 0.02),
      ...plantPines(cols, Math.round(rows * 0.82), rows * 1.1, 18, (cx + cw + 4) / cols, 1),
    ];

    return (g, { t, sig, weather }) => {
      const on = sig.active;
      const glow = 0.95 + (on ? sig.mid * 0.7 + sig.beat * 0.2 : 0.15);

      for (const s of stars) {
        const v = s.b * 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.8 + s.ph));
        const ch = starGlyph(v);
        if (ch) g.set(s.x, s.y, ch, ink(0.15 + v * 0.6));
      }

      // The curtains: a hem that waves and follows the spectrum, rays hanging
      // above it that fade upward and shimmer along their length.
      for (let x = 0; x < cols; x++) {
        const u = x / cols;
        const reach = clamp((u - 0.05) / 0.35) * clamp((1.02 - u) / 0.2);
        if (reach <= 0) continue;
        const lift = on ? bandAt(sig.bands, u) * rows * 0.12 : 0;
        const hem = rows * (0.36 + 0.05 * Math.sin(x * 0.05 + t * 0.3) + 0.06 * (fbm(x * 0.03, t * 0.08, 2, 5) - 0.5)) - lift;
        const ray = 0.25 + 0.75 * Math.pow(noise2(x * 0.22 + t * 0.4, t * 0.15, 9), 1.5);
        for (let y = Math.max(0, Math.floor(hem - rows * 0.32)); y <= hem && y < ridge[x]! - 0.5; y++) {
          const up = (hem - y) / (rows * 0.3);
          const shimmer = 0.75 + 0.25 * noise2(x * 0.3, y * 0.25 - t * 1.6, 4);
          const v = clamp(ray * reach * Math.exp(-up * 2.2) * glow * shimmer);
          if (v < 0.08) continue;
          // The upper fringe turns, as the real thing does.
          const fringe = up > 0.55 && v > 0.12;
          g.set(x, y, y >= hem - 0.6 ? '▁' : RAY[Math.min(4, Math.ceil(v * 4))]!, fringe ? hot(v * 0.7 + 0.1) : cool(v));
        }
      }

      // Ridges: a snow-lit crest line, the snowfields below it dotted thinner
      // with distance from the top.
      for (let x = 0; x < cols; x++) {
        const top = ridge[x]!;
        for (let y = Math.ceil(top); y < hz; y++) {
          const ch = ditherGlyph(SNOW, Math.exp(-(y - top) / 2.5) * 0.85, x, y);
          g.set(x, y, ch, ink(0.2 + Math.exp(-(y - top) / 2.5) * 0.25));
        }
      }
      drawCrest(g, ridge, ink(0.7));

      // The snowfield, faintly tinted by the sky.
      for (let y = hz; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const v = 0.25 + 0.3 * fbm(x * 0.05, y * 0.4, 2, 21) + (y - hz) / rows * 0.4;
          const ch = ditherGlyph(SNOW, v, x, y);
          if (ch !== ' ') g.set(x, y, ch, y < hz + 2 ? cool(0.3) : ink(0.3 + (y - hz) / rows * 0.4));
        }
      }

      for (const p of pines) drawPine(g, p, aspect, ink(0.55));

      // The cabin: logs, a snowed roof, two lit windows, a smoking chimney.
      const lamp = 0.82 + (on ? sig.bass * 0.15 : 0) + 0.04 * Math.sin(t * 9) * Math.sin(t * 5.3);
      for (let y = wallTop; y < floor; y++) {
        for (let x = cx; x < cx + cw; x++) g.set(x, y, '═', hot(0.12 + ((y - wallTop) % 2) * 0.05));
        g.set(cx - 1, y, '║', ink(0.35));
        g.set(cx + cw, y, '║', ink(0.35));
      }
      const winW = Math.max(3, Math.round(cw * 0.18));
      const winH = Math.max(2, wallH - 2);
      for (const wx of [cx + Math.round(cw * 0.14), cx + cw - Math.round(cw * 0.14) - winW]) {
        for (let y = wallTop + 1; y < wallTop + 1 + winH; y++) {
          for (let x = wx; x < wx + winW; x++) {
            const bar = x === wx + Math.floor(winW / 2) || y === wallTop + Math.floor(winH / 2) + 1;
            g.set(x, y, bar ? '┼' : '█', bar ? hot(0.3) : hot(clamp(lamp)));
          }
        }
        // Light spilling onto the snow.
        for (let y = floor; y < Math.min(rows, floor + 3); y++) {
          for (let x = wx - 2; x < wx + winW + 2; x++) {
            const v = (1 - (y - floor) / 3) * 0.5 * lamp;
            const ch = ditherGlyph(' .:░', v, x, y);
            if (ch !== ' ') g.set(x, y, ch, hot(0.3 + v * 0.4));
          }
        }
      }
      const door = cx + Math.round(cw / 2) - 1;
      for (let y = floor - wallH + 1; y < floor; y++) g.text(door, y, '▐▌', hot(0.1));
      // Roof, snow lying thick along it.
      for (let r = 0; r < roofH; r++) {
        const y = wallTop - roofH + r;
        const half = ((r + 1) * (cw / 2 + 2)) / roofH;
        const mid = cx + cw / 2;
        for (let x = Math.round(mid - half) + 1; x < Math.round(mid + half); x++) {
          g.set(x, y, r === 0 ? '▄' : r === 1 ? '█' : '▒', r < 2 ? ink(0.85) : hot(0.18));
        }
        g.set(Math.round(mid - half), y, '╱', ink(0.9));
        g.set(Math.round(mid + half), y, '╲', ink(0.9));
      }
      const chimney = cx + Math.round(cw * 0.72);
      const chimTop = wallTop - Math.round(roofH * 0.75);
      for (let y = chimTop; y < chimTop + 2; y++) g.text(chimney, y, '██', ink(0.2));
      g.text(chimney, chimTop - 1, '▀▀', ink(0.8));
      for (let i = 0; i < 9; i++) {
        const life = (t * 0.12 + i / 9) % 1;
        const x = chimney + 1 - life * cols * 0.12 + Math.sin(t * 0.8 + i * 2) * 1.5;
        const y = chimTop - 2 - life * rows * 0.3;
        g.set(x, y, life < 0.3 ? 'o' : life < 0.65 ? '°' : '·', mute(0.55 - life * 0.45));
      }

      // Snowfall, unless the real weather is something wetter.
      if (weather !== 'rain' && weather !== 'storm') {
        const n = Math.round(cols * rows * 0.014);
        for (let i = 0; i < n; i++) {
          const depth = hash2(i, 1, 61);
          const speed = 1.2 + depth * 3.5;
          const y = (hash2(i, 2, 61) * rows + t * speed) % rows;
          const x = (hash2(i, 3, 61) * cols + Math.sin(t * 0.6 + i) * 1.6 + t * 0.6) % cols;
          g.set(x, y, depth > 0.8 ? '*' : depth > 0.45 ? '•' : '·', ink(0.4 + depth * 0.55));
        }
      }
    };
  },
};
