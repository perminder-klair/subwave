// Focus mode's windows, drawn on the scene's own grid like a TUI dialog: the
// now-playing card bottom-left with the title as a half-block banner, and
// the DJ's words top-left while they're on the mic, typed out as they're
// heard. Pure apart from the banner, which arrives already rasterised.

import { drawBanner, type BannerMask } from './term/banner';
import { fitText, textCols, wrapText, type Grid } from './term/grid';
import { clamp } from './term/noise';
import { hot, ink, mute } from './term/palette';
import type { Signal } from './term/signal';

export interface StageInfo {
  title: string;
  /** "Artist — Album · 2023". */
  byline: string;
  /** Genre, BPM, key, moods: one line, already joined. */
  facts: string;
  elapsed: string;
  duration: string;
  ratio: number | null;
  /** Top-border status: "on air", "standby", "off air". */
  status: string;
  live: boolean;
}

export interface Caption {
  who: string;
  text: string;
}

/** The card's width for a grid, and the banner budget inside it. */
export function cardWidth(cols: number): number {
  return Math.max(Math.min(cols - 4, 40), Math.min(76, Math.round(cols * 0.46)));
}

/** Banner height in rows for a grid of `rows`. */
export function bannerRows(rows: number): number {
  return Math.round(clamp(rows * 0.11, 3, 6));
}

const LOWER = ' ▁▂▃▄▅▆▇█';

function frame(g: Grid, x: number, y: number, w: number, h: number, label: string, right?: string): void {
  // A soft drop shadow, then the window itself, opaque over the scene.
  for (let yy = y + 1; yy <= y + h; yy++) g.set(x + w, yy, '░', ink(0));
  for (let xx = x + 1; xx <= x + w; xx++) g.set(xx, y + h, '░', ink(0));
  g.box(x, y, w, h, ink(0.55), 'round', 0);
  g.text(x + 2, y, ` ${label} `, ink(1), w - 4);
  if (right) g.text(x + w - 3 - right.length, y, ` ${right} `, hot(0.8));
}

/** Rows the card needs, with or without a banner for its title. */
export function cardHeight(info: StageInfo, banner: BannerMask | null): number {
  return 2 + 1 + (banner ? banner.rows + 1 : 1) + 1 + 1 + (info.facts ? 1 : 0) + 1 + 1 + 1;
}

/** The now-playing card, bottom-left — or, `full`, across the whole width
 *  for a narrow stage. Returns its top row, so the caption can keep clear. */
export function drawNowPlaying(g: Grid, info: StageInfo, banner: BannerMask | null, sig: Signal, full = false): number {
  const w = full ? g.cols - 4 : Math.min(g.cols - 2, cardWidth(g.cols));
  const inner = w - 4;
  const titleRows = banner ? banner.rows + 1 : 1;
  const h = cardHeight(info, banner);
  const x = 2;
  const y = Math.max(0, g.rows - h - 1);
  frame(g, x, y, w, h, 'now playing', info.status);

  let row = y + 2;
  if (banner) {
    drawBanner(g, banner, x + 2, row, r => (r < banner.rows / 2 ? ink(1) : hot(0.78)), mute(0.35));
    row += titleRows;
  } else {
    g.text(x + 2, row, fitText(info.title.toUpperCase(), inner), ink(1));
    row += 1;
  }
  row += 1;
  g.text(x + 2, row++, fitText(info.byline, inner), ink(0.8));
  if (info.facts) g.text(x + 2, row++, fitText(info.facts, inner), hot(0.65));

  // A one-row level meter the width of the card.
  for (let c = 0; c < inner; c++) {
    const v = info.live && sig.active ? sig.bands[Math.floor((c / inner) * sig.bands.length)] ?? 0 : 0;
    g.set(x + 2 + c, row, v > 0.04 ? LOWER[Math.min(8, Math.round(v * 8))]! : '▁', v > 0.04 ? ink(0.35 + v * 0.5) : mute(0.2));
  }
  row++;

  const times = info.ratio == null ? `${info.elapsed} · live` : `${info.elapsed} / ${info.duration}`;
  const barW = Math.max(4, inner - times.length - 2);
  const filled = info.ratio == null ? 0 : Math.round(info.ratio * barW);
  for (let c = 0; c < barW; c++) {
    g.set(x + 2 + c, row, c < filled ? '━' : '─', c < filled ? hot(0.8) : ink(0.12));
  }
  if (info.ratio != null && filled < barW) g.set(x + 2 + filled, row, '╸', hot(1));
  g.text(x + 2 + barW + 2, row, times, ink(0.7));
  return y;
}

/** The DJ's words, top-left, revealed `shown` characters in. Skipped when
 *  the grid is too short to hold it clear of the card below. */
export function drawCaption(g: Grid, cap: Caption, shown: number, floor: number): void {
  const w = Math.min(g.cols - 4, Math.max(30, Math.min(64, Math.round(g.cols * 0.42))));
  const lines = wrapText(`“${cap.text}”`, w - 4, 4);
  const h = lines.length + 4;
  const x = 2;
  const y = 1;
  if (y + h + 1 > floor) return;
  frame(g, x, y, w, h, `${cap.who.toUpperCase()} ●`, 'on the mic');
  let left = Math.max(0, Math.floor(shown));
  let cursor = false;
  lines.forEach((line, i) => {
    const chars = [...line];
    const part = chars.slice(0, Math.max(0, left)).join('');
    g.text(x + 2, y + 2 + i, part, ink(0.95));
    if (!cursor && part.length < line.length) {
      g.set(x + 2 + textCols(part), y + 2 + i, '▌', hot(0.9));
      cursor = true;
    }
    left -= chars.length + 1;
  });
}
