'use client';

// cover.raw, printed. Reads the artwork's pixels through a canvas, which the
// controller allows cross-origin (cors.ts is `*` and helmet's resource
// policy is pinned to cross-origin). If a deployment's proxy strips that and
// the canvas comes back tainted, `onTainted` hands the box back to a plain
// <img>.

import { useEffect, useRef, useState } from 'react';
import AsciiCanvas, { type PaintEnv } from './term/AsciiCanvas';
import type { Grid } from './term/grid';
import { hash2 } from './term/noise';
import { ink, mute } from './term/palette';
import { drawCover } from './cover';

const coverFont = (w: number) => Math.max(6, Math.min(10, w / 21));

/** Static for "no art": a dead channel, still. */
function noArt(g: Grid): void {
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const v = hash2(x, y, 3);
      if (v > 0.55) g.set(x, y, v > 0.85 ? '▒' : '░', v > 0.8 ? ink(0.2) : ink(0.05));
    }
  }
  const label = ' no art ';
  g.text(Math.floor((g.cols - label.length) / 2), Math.floor(g.rows / 2), label, mute(0.8));
}

export default function AsciiCover({ url, onTainted }: { url: string | null; onTainted: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const sampled = useRef<{ key: string; px: Uint8ClampedArray } | null>(null);
  const scratch = useRef<CanvasRenderingContext2D | null>(null);
  const taintedRef = useRef(onTainted);
  taintedRef.current = onTainted;

  useEffect(() => {
    setImg(null);
    sampled.current = null;
    if (!url) return;
    let alive = true;
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.decoding = 'async';
    el.onload = () => { if (alive) setImg(el); };
    el.src = url;
    return () => { alive = false; };
  }, [url]);

  const paint = (g: Grid, _t: number, env: PaintEnv) => {
    if (!img) { noArt(g); return; }
    const key = `${img.src}:${g.cols}x${g.rows}`;
    if (sampled.current?.key !== key) {
      scratch.current ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const ctx = scratch.current;
      if (!ctx) return;
      ctx.canvas.width = g.cols;
      ctx.canvas.height = g.rows;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, g.cols, g.rows);
      try {
        sampled.current = { key, px: ctx.getImageData(0, 0, g.cols, g.rows).data };
      } catch {
        taintedRef.current();
        return;
      }
    }
    drawCover(g, sampled.current.px, env.theme.bg);
  };

  return <AsciiCanvas paint={paint} fontSize={coverFont} fps={0} frame={img} lineHeight={1} className="h-full w-full" />;
}
