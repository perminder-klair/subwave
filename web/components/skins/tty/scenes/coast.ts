// coast.ans — a causeway of basalt columns stepping down into the sea under
// a high sun. The columns ARE the analyser: each one rises and settles with
// its band of the spectrum, low notes at the sea end. The swell runs on the
// bass, and spray goes up off the shortest columns on the hits.

import { clamp, fbm, hash2, smoothstep } from '../term/noise';
import { cool, hot, ink, mute } from '../term/palette';
import { bandAt } from '../term/signal';
import { HAZE, ditherGlyph, drawCrest, drawDisc, type Scene } from './kit';

interface Column { x: number; w: number; base: number; h: number }

export const coast: Scene = {
  id: 'coast',
  file: 'coast.ans',
  blurb: 'basalt columns into the sea: each column is a band of the spectrum, spray on the hits',
  build(cols, rows, aspect) {
    const hz = Math.round(rows * 0.42);
    const sunX = cols * 0.8;
    const sunY = rows * 0.13;
    const sunR = rows * 0.075;

    // A headland on the far left, falling into the sea.
    const cliff = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      const u = x / cols;
      // A plateau that drops off steeply toward the bay.
      const fall = 1 - smoothstep(clamp((u - 0.12) / 0.14));
      cliff[x] = hz - rows * fall * (0.17 + 0.06 * fbm(x * 0.12, 1.7, 3, 81)) - (fall > 0.02 ? 1 : 0);
    }

    // The causeway: columns from the sea (left, low) up to the cliff of
    // columns at the right edge.
    const run: Column[] = [];
    const startX = Math.round(cols * 0.45);
    for (let x = startX, i = 0; x < cols + 4; i++) {
      const w = 3 + Math.floor(hash2(i, 1, 91) * 3);
      const u = (x - startX) / (cols - startX);
      const base = Math.round(rows - 1 - u * rows * 0.06);
      const h = Math.round(rows * (0.06 + Math.pow(u, 1.35) * 0.48) + hash2(i, 2, 91) * rows * 0.05);
      run.push({ x, w, base, h });
      x += w;
    }

    const lifts = new Float32Array(run.length);

    return (g, { t, sig, weather }) => {
      const on = sig.active;
      const overcast = weather === 'rain' || weather === 'storm' || weather === 'fog';

      // A pale, high sky: dotted thicker toward the horizon, a cloud or two.
      for (let y = 0; y < hz; y++) {
        for (let x = 0; x < cols; x++) {
          const c = fbm(x * 0.03 + t * 0.012, y * 0.16, 4, 83) - y / (rows * 2.2);
          if (c > 0.58) {
            g.set(x, y, ditherGlyph(' .·:', (c - 0.58) * 6, x, y), ink(0.35 + (c - 0.58) * 2));
            continue;
          }
          const ch = ditherGlyph(HAZE, Math.pow(y / hz, 2.2) * 0.5, x, y);
          if (ch !== ' ') g.set(x, y, ch, cool(0.2));
        }
      }
      for (let y = Math.floor(sunY - sunR * 1.8); !overcast && y <= sunY + sunR * 1.8; y++) {
        for (let x = Math.floor(sunX - (sunR * 1.8) / aspect); x <= sunX + (sunR * 1.8) / aspect; x++) {
          const d = Math.hypot((x - sunX) * aspect, y - sunY) / sunR;
          if (d > 1.2 && d < 1.8 && (x + y) % 2 === 0) g.set(x, y, '·', hot(0.55));
        }
      }
      // Behind rain or fog the sun is a pale disc, not a blaze.
      drawDisc(g, sunX, sunY, sunR, aspect, overcast ? mute(0.55) : hot(1));

      // The sea: swell lines moving in toward the shore, taller on the bass.
      const swell = 0.62 - (on ? sig.bass * 0.25 : 0);
      for (let y = hz; y < rows; y++) {
        const near = (y - hz) / (rows - hz);
        for (let x = 0; x < cols; x++) {
          const phase = Math.sin(x * (0.35 - near * 0.2) + y * 1.7 - t * (1.2 + near)) + fbm(x * 0.08, y * 0.6 + t * 0.2, 2, 85) - 0.5;
          if (phase > swell + 0.25) g.set(x, y, '~', cool(0.5 + near * 0.45));
          else if (phase > swell) g.set(x, y, '-', cool(0.3 + near * 0.3));
          else if (hash2(x, y, Math.floor(t * 2)) > 0.985) g.set(x, y, '·', cool(0.6));
        }
      }
      // Glitter under the sun.
      for (let y = hz + 1; !overcast && y < rows; y++) {
        const spread = 1 + (y - hz) * 0.45;
        for (let x = Math.floor(sunX - spread); x <= sunX + spread; x++) {
          if (hash2(x, y, Math.floor(t * 6)) > 0.8) g.set(x, y, '=', hot(0.7));
        }
      }
      for (let x = 0; x < cols; x++) if (g.get(x, hz) === 32) g.set(x, hz, '─', cool(0.45));

      // The headland.
      let land = 0;
      for (let x = 0; x < cols; x++) {
        const top = cliff[x]!;
        if (top >= hz) break;
        land = x + 1;
        for (let y = Math.ceil(top); y <= hz; y++) g.set(x, y, ditherGlyph(HAZE, 0.3 + (y - top) * 0.02, x, y), mute(0.4));
      }
      drawCrest(g, cliff, ink(0.55), 0, land);

      // The columns, each lifted by its band and settling slowly.
      run.forEach((c, i) => {
        const target = on ? bandAt(sig.bands, i / Math.max(1, run.length - 1)) : 0;
        lifts[i] = lifts[i]! + (target - lifts[i]!) * (target > lifts[i]! ? 0.35 : 0.06);
        const h = Math.round(c.h + lifts[i]! * rows * 0.12);
        const top = c.base - h;
        for (let y = top; y < rows; y++) {
          for (let x = c.x; x < c.x + c.w; x++) {
            const k = x - c.x;
            const joint = (y - top) % 5 === 4;
            if (y === top) g.set(x, y, '▄', ink(0.85));
            else if (k === c.w - 1) g.set(x, y, '│', ink(0.08));
            else if (joint) g.set(x, y, '─', ink(0.18));
            else g.set(x, y, k === 0 ? '█' : k < c.w / 2 ? '▓' : '▒', ink(0.55 - (k / c.w) * 0.3));
          }
        }
        // Foam where the sea meets the short ones.
        if (h < rows * 0.2) {
          for (let x = c.x - 1; x <= c.x + c.w; x++) {
            if (hash2(x, Math.floor(t * 3), 87) > 0.5) g.set(x, c.base - 1 - (hash2(x, 1, 87) > 0.6 ? 1 : 0), '░', ink(0.8));
          }
        }
      });

      // Spray off the sea end on the hits.
      if (on && sig.onset > 0.25) {
        for (let i = 0; i < 18; i++) {
          const c = run[Math.floor(hash2(i, Math.floor(t * 8), 89) * Math.min(4, run.length))]!;
          const life = hash2(i, 2, 89);
          g.set(c.x + hash2(i, 3, 89) * c.w * 2 - c.w / 2, c.base - c.h - 1 - life * rows * 0.15 * sig.onset, life > 0.6 ? '·' : '*', ink(0.9));
        }
      }

      // Gulls.
      for (let i = 0; i < 3; i++) {
        const x = cols - (((hash2(i, 1, 93) * cols + t * (2 + i * 0.4)) % (cols + 10)) - 5);
        const y = rows * (0.12 + hash2(i, 2, 93) * 0.14) + Math.sin(t * 1.5 + i) * 0.6;
        g.set(x, y, Math.sin(t * 5 + i * 2) > 0 ? 'v' : '‿', ink(0.55));
      }
    };
  },
};
