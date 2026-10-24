'use client';

// A line of text as a half-block banner, for the boot screen's masthead.

import AsciiCanvas, { type PaintEnv } from './term/AsciiCanvas';
import { drawBanner, fitBanner } from './term/banner';
import type { Grid } from './term/grid';
import { hot, ink, mute } from './term/palette';

export default function BannerArt({ text, className }: { text: string; className?: string }) {
  const paint = (g: Grid, _t: number, env: PaintEnv) => {
    const mask = fitBanner(text.toUpperCase(), env.fontFamily, env.cellW / env.cellH, g.cols - 1, g.rows - 1);
    if (mask) drawBanner(g, mask, 0, 0, r => (r < mask.rows / 2 ? ink(1) : hot(0.78)), mute(0.35));
    else g.text(0, 0, text.toUpperCase(), ink(1));
  };
  return <AsciiCanvas paint={paint} fontSize={13} fps={0} frame={text} className={className} />;
}
