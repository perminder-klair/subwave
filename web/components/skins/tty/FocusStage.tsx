'use client';

// Focus mode's stage: the scene full-bleed, the station's weather over it,
// and the now-playing card and the DJ's caption drawn on the same grid. The
// whole drawing is aria-hidden; the skin keeps the same facts in the
// accessibility tree as text.

import { useRef } from 'react';
import AsciiCanvas, { type PaintEnv } from './term/AsciiCanvas';
import { fitBanner } from './term/banner';
import { Grid } from './term/grid';
import { STILL_SIGNAL, type Signal } from './term/signal';
import { drawWeather, sceneById, type SceneDraw, type SceneId, type Weather } from './scenes';
import { bannerRows, cardHeight, cardWidth, drawCaption, drawNowPlaying, type Caption, type StageInfo } from './focus';

/** Characters a second the caption types at — a little ahead of speech. */
const CAPTION_CPS = 30;
/** Below this many columns the stage stacks instead of overlaying. */
const NARROW_COLS = 100;

/** ~150 columns across whatever the window is, within readable bounds. */
const stageFont = (w: number) => Math.max(10, Math.min(15, Math.round(w / 150 / 0.6)));

export default function FocusStage({ sceneId, weather, info, caption, sample, calm, paused }: {
  sceneId: SceneId;
  weather: Weather;
  info: StageInfo;
  caption: Caption | null;
  sample: (nowMs: number) => Signal;
  calm: boolean;
  /** Covered by the tune-in screen. */
  paused: boolean;
}) {
  const built = useRef<{ key: string; draw: SceneDraw; sky: Grid | null } | null>(null);
  const typed = useRef<{ text: string; at: number } | null>(null);

  const paint = (g: Grid, t: number, env: PaintEnv) => {
    const scene = sceneById(sceneId);
    const aspect = env.cellW / env.cellH;
    // A narrow stage stacks like the panes do: the scene above, the card
    // across the full width below it, rather than the card over the scene's
    // focal point.
    const narrow = g.cols < NARROW_COLS;
    const title = info.title.toUpperCase();
    const cardInner = (narrow ? g.cols - 4 : cardWidth(g.cols)) - 4;
    const banner = title ? fitBanner(title, env.fontFamily, aspect, cardInner, bannerRows(g.rows)) : null;
    const sceneRows = narrow ? Math.max(4, g.rows - cardHeight(info, banner) - 1) : g.rows;

    const key = `${sceneId}:${g.cols}x${sceneRows}:${aspect.toFixed(3)}`;
    if (built.current?.key !== key) {
      built.current = {
        key,
        draw: scene.build(g.cols, sceneRows, aspect),
        sky: sceneRows < g.rows ? new Grid(g.cols, sceneRows) : null,
      };
    }
    const sig = calm ? STILL_SIGNAL : sample(performance.now());
    const frame = { t, sig, weather };
    const { draw, sky } = built.current;
    const into = sky ?? g;
    if (sky) sky.clear();
    draw(into, frame);
    drawWeather(into, frame, scene.ownWeather);
    if (sky) {
      g.chars.set(sky.chars);
      g.ink.set(sky.ink);
    }

    const top = drawNowPlaying(g, info, banner, sig, narrow);
    if (caption) {
      if (typed.current?.text !== caption.text) typed.current = { text: caption.text, at: t };
      drawCaption(g, caption, calm ? Infinity : (t - typed.current.at) * CAPTION_CPS, top);
    }
  };

  return (
    <AsciiCanvas
      paint={paint}
      fontSize={stageFont}
      fps={20}
      still={calm}
      stillAt={7.3}
      frame={`${sceneId}|${weather}|${JSON.stringify(info)}|${caption?.text ?? ''}`}
      glow
      paused={paused}
      className="absolute inset-0"
    />
  );
}
