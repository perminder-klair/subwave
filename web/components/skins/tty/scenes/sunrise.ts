// sunrise.ans — hot-air balloons drifting over a misty valley as the sun
// clears the hills. The sun's rays reach further as the track gets louder,
// the balloons lift on the bass, and their burners fire on the beat — one
// balloon at a time, round the flight.

import { clamp, fbm, hash2 } from '../term/noise';
import { cool, hot, ink, mute } from '../term/palette';
import { HAZE, dither, ditherGlyph, drawCrest, drawDisc, ridged, type Scene } from './kit';

const SKY = ' .·:░▒';

interface Balloon { x0: number; y0: number; r: number; speed: number; ph: number; bands: [number, number, number] }

export const sunrise: Scene = {
  id: 'sunrise',
  file: 'sunrise.ans',
  blurb: 'balloons over a valley at sunrise: rays on the level, lift on the bass, burners on the beat',
  build(cols, rows, aspect) {
    const hz = Math.round(rows * 0.56);
    const sx = cols * 0.74;
    const sy = hz - rows * 0.12;
    const sunR = rows * 0.13;

    // Three ranges of hills, far to near, each a smooth silhouette.
    const layers = [0, 1, 2].map(k => {
      const top = new Float32Array(cols);
      for (let x = 0; x < cols; x++) {
        const lift = ridged(x * (0.016 + k * 0.008), k * 7.1, 31 + k) * 0.55 + fbm(x * 0.04, k, 2, 35 + k) * 0.45;
        top[x] = hz - rows * 0.06 + k * rows * 0.13 - rows * (0.22 - k * 0.05) * lift;
      }
      return top;
    });

    const flight = Array.from({ length: 5 }, (_, i): Balloon => {
      const depth = hash2(i, 0, 51);
      return {
        x0: hash2(i, 1, 51),
        y0: rows * (0.1 + hash2(i, 2, 51) * 0.3),
        r: rows * (0.05 + depth * 0.07),
        speed: 0.004 + depth * 0.006,
        ph: hash2(i, 3, 51) * 6.28,
        bands: [hot(0.85), i % 2 ? ink(0.92) : cool(0.85), hot(0.55)],
      };
    }).sort((a, b) => a.r - b.r);

    return (g, { t, sig, weather }) => {
      const on = sig.active;
      const overcast = weather === 'rain' || weather === 'storm' || weather === 'fog';

      // The sky warms toward the sun; above it the dawn is still cold.
      for (let y = 0; y < hz + rows * 0.1; y++) {
        for (let x = 0; x < cols; x++) {
          const d = Math.hypot((x - sx) * aspect, y - sy) / rows;
          const sun = Math.exp(-d * 3.2);
          const v = Math.pow(y / hz, 2) * 0.35 + sun * 0.75;
          const ch = ditherGlyph(SKY, v, x, y);
          if (ch !== ' ') g.set(x, y, ch, sun > 0.25 ? hot(0.2 + sun * 0.55) : cool(0.1 + v * 0.4));
        }
      }

      // Rays: alternate wedges round the sun, reaching further when loud.
      const reach = overcast ? 0 : sunR * (2.2 + (on ? sig.level * 2.2 : 0.4));
      for (let y = 0; y < hz; y++) {
        for (let x = 0; x < cols; x++) {
          const dx = (x - sx) * aspect;
          const dy = y - sy;
          const d = Math.hypot(dx, dy);
          if (d < sunR * 1.15 || d > reach) continue;
          const a = Math.atan2(dy, dx);
          if (Math.sin(a * 14 + t * 0.15) < 0.55) continue;
          const v = 1 - (d - sunR) / (reach - sunR);
          if (v < dither(x, y) * 0.8) continue;
          const steep = Math.abs(Math.cos(a)) < 0.4;
          g.set(x, y, steep ? '│' : Math.abs(Math.sin(a)) < 0.4 ? '─' : dx * dy > 0 ? '╲' : '╱', hot(0.45 + v * 0.45));
        }
      }

      // The disc, rising behind the far hills.
      drawDisc(g, sx, sy, sunR * 1.12, aspect, overcast ? mute(0.35) : hot(0.8));
      drawDisc(g, sx, sy, sunR, aspect, overcast ? mute(0.6) : hot(1));

      // The hills, far to near. Each is a line along its brow over a body
      // dotted thinner the nearer it is, so the far range sits in the haze.
      layers.forEach((top, k) => {
        for (let x = 0; x < cols; x++) {
          for (let y = Math.floor(top[x]!) + 1; y < rows; y++) {
            const v = (0.42 - k * 0.12) * (1 - (y - top[x]!) / rows);
            g.set(x, y, ditherGlyph(HAZE, v, x, y), k === 0 ? mute(0.35) : ink(0.1 + k * 0.06));
          }
        }
        drawCrest(g, top, k === 0 ? mute(0.6) : ink(0.35 + k * 0.2));
      });

      // Mist lying in the valley between the far and near hills.
      for (let y = hz - 1; y < hz + rows * 0.16; y++) {
        for (let x = 0; x < cols; x++) {
          const m = fbm(x * 0.03 + t * 0.03, y * 0.5, 3, 41);
          if (m > 0.6) g.set(x, y, m > 0.68 ? '~' : '-', ink(0.25 + (m - 0.6) * 2));
        }
      }

      // The flight. Burners take turns on the beat.
      const beatNo = Math.floor(t * 1.7);
      flight.forEach((b, i) => {
        const span = cols + b.r * 4 / aspect;
        const bx = ((b.x0 * span + t * b.speed * cols) % span) - b.r * 2 / aspect;
        const lift = on ? sig.bass * b.r * 0.6 : 0;
        const by = b.y0 + Math.sin(t * 0.35 + b.ph) * 0.8 - lift;
        const rw = b.r / aspect;
        for (let y = Math.floor(by - b.r); y <= by + b.r; y++) {
          const dy = (y - by) / b.r;
          // An envelope tapering to its mouth.
          const half = rw * Math.sqrt(Math.max(0, 1 - dy * dy)) * (dy > 0 ? 1 - dy * 0.4 : 1);
          for (let x = Math.ceil(bx - half); x <= bx + half; x++) {
            const u = (x - bx) / Math.max(1, half);
            const gore = Math.floor((u + 1) * 2.5);
            const lit = clamp(0.55 + u * 0.4);
            const edge = Math.abs(u) > 0.86;
            g.set(x, y, edge ? (u < 0 ? '(' : ')') : lit > 0.75 ? '█' : lit > 0.45 ? '▓' : '▒', b.bands[gore % 3]!);
          }
        }
        // Ropes, burner and basket.
        const mouth = by + b.r;
        const basket = mouth + Math.max(2, Math.round(b.r * 0.6));
        for (let y = Math.ceil(mouth); y < basket; y++) {
          const k = (y - mouth) / (basket - mouth);
          g.set(bx - rw * 0.5 * (1 - k) - 0.5, y, '╲', ink(0.5));
          g.set(bx + rw * 0.5 * (1 - k) + 0.5, y, '╱', ink(0.5));
        }
        const firing = on ? sig.beat > 0.45 && beatNo % flight.length === i : Math.sin(t * 0.7 + i) > 0.9;
        if (firing) g.set(bx, mouth + 0.6, '▲', hot(1));
        g.text(bx - 1, basket, '▐█▌', ink(0.45));
      });

      // A few birds crossing.
      for (let i = 0; i < 4; i++) {
        const x = ((hash2(i, 1, 71) * cols + t * (1.5 + i * 0.3)) % (cols + 10)) - 5;
        const y = rows * (0.18 + hash2(i, 2, 71) * 0.15) + Math.sin(t * 2 + i) * 0.5;
        g.set(x, y, Math.sin(t * 6 + i * 2) > 0 ? 'v' : '‿', ink(0.5));
      }
    };
  },
};
