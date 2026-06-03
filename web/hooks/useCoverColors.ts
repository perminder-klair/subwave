// Pull a couple of representative colours out of the current cover art so the
// player can wash a soft, art-derived tint behind itself. Pure canvas — no
// dependency. The controller serves /cover/* with a wide-open CORS header, so a
// crossOrigin image can be drawn to a canvas and read back without tainting;
// any failure (taint, decode error, no support) resolves to nulls and the
// caller simply skips the tint.

import { useEffect, useState } from 'react';

export interface CoverColors {
  // Saturation-weighted dominant colour — the one that reads as "the art's
  // colour". `rgb(r, g, b)` strings, or null before/if extraction fails.
  vibrant: string | null;
  // Flat average — a calmer, usually darker companion for the gradient's tail.
  average: string | null;
}

const EMPTY: CoverColors = { vibrant: null, average: null };

// Downscale target. 24×24 is plenty to find dominant hues and keeps the
// per-track getImageData walk to ~576 pixels.
const SAMPLE = 24;
// 5-bit-per-channel quantisation (32 levels) buckets near-identical colours
// together so a dominant hue accumulates weight instead of scattering.
const QUANT = 8; // 256 / 32

function rgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

// Cheap saturation proxy (max-min over max), 0..1. Greys score ~0 so they
// don't win the dominant-colour vote against a smaller but vivid region.
function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function useCoverColors(coverSrc: string | null): CoverColors {
  const [colors, setColors] = useState<CoverColors>(EMPTY);

  useEffect(() => {
    if (!coverSrc) {
      setColors(EMPTY);
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';

    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

        // buckets: quantised-colour key -> accumulated sum + score
        const buckets = new Map<
          number,
          { r: number; g: number; b: number; n: number; score: number }
        >();
        let ar = 0;
        let ag = 0;
        let ab = 0;
        let an = 0;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          const a = data[i + 3] ?? 0;
          if (a < 128) continue; // skip transparent padding

          ar += r;
          ag += g;
          ab += b;
          an += 1;

          const sat = saturation(r, g, b);
          // Down-weight near-black and blown-out near-white — both make muddy
          // washes — while letting mid-tone vivid colours dominate.
          const lum = (r + g + b) / 3 / 255;
          const weight = (0.25 + sat) * (lum > 0.08 && lum < 0.95 ? 1 : 0.25);

          const key =
            (Math.floor(r / QUANT) << 10) |
            (Math.floor(g / QUANT) << 5) |
            Math.floor(b / QUANT);
          const bucket = buckets.get(key);
          if (bucket) {
            bucket.r += r;
            bucket.g += g;
            bucket.b += b;
            bucket.n += 1;
            bucket.score += weight;
          } else {
            buckets.set(key, { r, g, b, n: 1, score: weight });
          }
        }

        if (an === 0) {
          setColors(EMPTY);
          return;
        }

        let best: { r: number; g: number; b: number; n: number; score: number } | null = null;
        for (const bucket of buckets.values()) {
          if (!best || bucket.score > best.score) best = bucket;
        }

        const vibrant = best ? rgb(best.r / best.n, best.g / best.n, best.b / best.n) : null;
        const average = rgb(ar / an, ag / an, ab / an);
        setColors({ vibrant, average });
      } catch {
        // Tainted canvas or read failure — leave the tint off rather than throw.
        if (!cancelled) setColors(EMPTY);
      }
    };
    img.onerror = () => {
      if (!cancelled) setColors(EMPTY);
    };
    img.src = coverSrc;

    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [coverSrc]);

  return colors;
}
