'use client';

// The one painter for every character drawing in the TTY skin. It sizes a
// Grid to its box the way a terminal answers SIGWINCH, hands it to `paint`,
// and puts the result on a canvas:
//
//  - Glyphs are rendered once per (code point, colour) into an atlas and
//    blitted from there, and only cells that changed since the last frame are
//    repainted — a full-window scene is ~10k cells, and fillText per cell per
//    frame is what that would otherwise cost.
//  - Colours come from the theme tokens (see palette.ts), re-read when the
//    theme changes under us: the provider writes them onto <html>, so one
//    MutationObserver there catches every switch.
//  - With `glow`, cells whose colour blooms are also painted onto a second
//    canvas under the first that CSS blurs — the phosphor halo, at the cost
//    of a compositor filter rather than a per-glyph shadow.
//  - `still` (lite mode, reduced motion) paints one frame at `stillAt` and
//    no loop runs; it repaints only on resize, theme or `frame` change.

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { Grid, SPACE, WIDE_TAIL, cellWidth } from './grid';
import { createColorProbe, readThemeRgb, watchTheme } from '@/lib/theme-rgb';
import { buildPalette, glows, isDarkTheme, type ThemeRgb } from './palette';
import { drawGlyph, type GlyphMetrics } from './glyphs';
import styles from './AsciiCanvas.module.css';

export interface PaintEnv {
  /** Cell size in CSS pixels. Scenes use w/h to keep circles round. */
  cellW: number;
  cellH: number;
  /** The computed font-family of the box (the theme's mono face). */
  fontFamily: string;
  theme: ThemeRgb;
  dark: boolean;
}

export type Painter = (g: Grid, t: number, env: PaintEnv) => void;

interface AsciiCanvasProps {
  /** Fills the grid for time `t` (seconds). Read through a ref: a new
   *  function each render doesn't restart anything. */
  paint: Painter;
  /** Glyph size in CSS px, or chosen from the box's size. */
  fontSize: number | ((w: number, h: number) => number);
  /** Frames per second while animating; 0 paints only when `frame` changes. */
  fps?: number;
  still?: boolean;
  /** The moment a still frame shows. */
  stillAt?: number;
  /** Repaint key for fps 0 and still frames. */
  frame?: unknown;
  lineHeight?: number;
  glow?: boolean;
  className?: string;
}

/** Glyphs rendered once per (code point, colour), two cells wide per slot so
 *  a wide glyph fits. When it fills it simply starts over. */
class GlyphAtlas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private slots = new Map<number, number>();
  private next = 0;
  private perRow = 32;
  private capacity = 0;
  private m: GlyphMetrics | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
  }

  reset(m: GlyphMetrics): void {
    this.m = m;
    this.slots.clear();
    this.next = 0;
    const rows = Math.max(8, Math.floor(4096 / Math.max(1, m.h)));
    this.canvas.width = this.perRow * m.w * 2;
    this.canvas.height = rows * m.h;
    this.capacity = this.perRow * rows;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Atlas origin of a glyph, rendering it on first use. */
  locate(cp: number, inkIndex: number, color: string): [number, number] {
    const m = this.m!;
    const key = cp * 512 + inkIndex;
    let slot = this.slots.get(key);
    if (slot === undefined) {
      if (this.next >= this.capacity) this.reset(m);
      slot = this.next++;
      this.slots.set(key, slot);
      const sx = (slot % this.perRow) * m.w * 2;
      const sy = Math.floor(slot / this.perRow) * m.h;
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(sx, sy, m.w * 2, m.h);
      this.ctx.clip();
      drawGlyph(this.ctx, cp, sx, sy, m, color);
      this.ctx.restore();
    }
    return [(slot % this.perRow) * m.w * 2, Math.floor(slot / this.perRow) * m.h];
  }
}

export default function AsciiCanvas({
  paint, fontSize, fps = 20, still = false, stillAt = 0, frame, lineHeight = 1.2, glow = false, className,
}: AsciiCanvasProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glowRef = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const stillAtRef = useRef(stillAt);
  stillAtRef.current = stillAt;
  const requestRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!host || !canvas || !ctx) return;
    const glowCanvas = glow ? glowRef.current : null;
    const gctx = glowCanvas?.getContext('2d') ?? null;
    const probe = createColorProbe();
    if (!probe) return;

    const atlas = new GlyphAtlas();
    let grid = new Grid(0, 0);
    let prevChars = new Uint32Array(0);
    let prevInk = new Uint16Array(0);
    let marks = new Uint8Array(0);
    let full = true;
    let theme = readThemeRgb(host, probe);
    let palette = buildPalette(theme);
    let m: GlyphMetrics | null = null;
    let env: PaintEnv | null = null;
    let raf = 0;
    let last = -Infinity;
    const t0 = performance.now();
    let disposed = false;

    const layout = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const dpr = window.devicePixelRatio || 1;
      const fs = fontSizeRef.current;
      const px = typeof fs === 'function' ? fs(rect.width, rect.height) : fs;
      const family = getComputedStyle(host).fontFamily || 'monospace';
      const font = `500 ${Math.round(px * dpr)}px ${family}`;
      ctx.font = font;
      const tm = ctx.measureText('M');
      const w = Math.max(1, Math.round(tm.width));
      const h = Math.max(1, Math.round(px * lineHeight * dpr));
      const ascent = tm.fontBoundingBoxAscent || px * dpr * 0.8;
      const descent = tm.fontBoundingBoxDescent || px * dpr * 0.2;
      const cols = Math.floor((rect.width * dpr) / w);
      const rows = Math.floor((rect.height * dpr) / h);
      const next: GlyphMetrics = {
        w, h, font,
        baseline: Math.round((h - (ascent + descent)) / 2 + ascent),
        stroke: Math.max(1, Math.round(dpr)),
      };
      const changed = !m || m.w !== w || m.h !== h || m.font !== font || grid.cols !== cols || grid.rows !== rows;
      if (changed) {
        m = next;
        atlas.reset(m);
        grid = new Grid(cols, rows);
        prevChars = new Uint32Array(cols * rows);
        prevInk = new Uint16Array(cols * rows);
        marks = new Uint8Array(cols * rows);
        // Centred: the box rarely divides into whole cells, and an even
        // margin reads as a terminal window rather than a cropped one.
        for (const c of glowCanvas ? [canvas, glowCanvas] : [canvas]) {
          c.width = cols * w;
          c.height = rows * h;
          c.style.width = `${(cols * w) / dpr}px`;
          c.style.height = `${(rows * h) / dpr}px`;
          c.style.left = `${Math.floor((rect.width - (cols * w) / dpr) / 2)}px`;
          c.style.top = `${Math.floor((rect.height - (rows * h) / dpr) / 2)}px`;
        }
        full = true;
      }
      env = { cellW: w / dpr, cellH: h / dpr, fontFamily: family, theme, dark: isDarkTheme(theme) };
      return true;
    };

    const flush = () => {
      if (!m) return;
      const { w, h } = m;
      const { cols, chars, ink } = grid;
      const n = chars.length;
      if (full) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        gctx?.clearRect(0, 0, gctx.canvas.width, gctx.canvas.height);
        marks.fill(1);
      } else {
        for (let i = 0; i < n; i++) marks[i] = chars[i] !== prevChars[i] || ink[i] !== prevInk[i] ? 1 : 0;
        // A wide glyph spans its tail: repaint it when either half changed.
        for (let i = 0; i < n - 1; i++) {
          if (marks[i + 1] && cellWidth(chars[i]!) === 2) marks[i] = 1;
          if (marks[i] && cellWidth(prevChars[i]!) === 2) marks[i + 1] = 1;
        }
        for (let i = 0; i < n; i++) {
          if (!marks[i]) continue;
          const x = (i % cols) * w;
          const y = Math.floor(i / cols) * h;
          ctx.clearRect(x, y, w, h);
          gctx?.clearRect(x, y, w, h);
        }
      }
      for (let i = 0; i < n; i++) {
        if (!marks[i]) continue;
        const cp = chars[i]!;
        const k = ink[i]!;
        prevChars[i] = cp;
        prevInk[i] = k;
        if (cp === SPACE || cp === WIDE_TAIL) continue;
        const color = palette[k] ?? palette[0]!;
        const [sx, sy] = atlas.locate(cp, k, color);
        const sw = cellWidth(cp) === 2 ? w * 2 : w;
        const x = (i % cols) * w;
        const y = Math.floor(i / cols) * h;
        ctx.drawImage(atlas.canvas, sx, sy, sw, h, x, y, sw, h);
        if (gctx && glows(k)) gctx.drawImage(atlas.canvas, sx, sy, sw, h, x, y, sw, h);
      }
      full = false;
    };

    const paintAt = (t: number) => {
      if (!env || grid.cols === 0 || grid.rows === 0) return;
      grid.clear();
      paintRef.current(grid, t, env);
      flush();
    };

    const animating = fps > 0 && !still;
    const tick = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / fps - 2) return;
      last = now;
      paintAt((now - t0) / 1000);
    };
    const paintOnce = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (!disposed) paintAt(still ? stillAtRef.current : (performance.now() - t0) / 1000); });
    };
    requestRef.current = () => { if (!animating) paintOnce(); };

    const relayout = () => {
      if (!layout()) return;
      if (animating) last = -Infinity;
      else paintOnce();
    };
    const retheme = () => {
      theme = readThemeRgb(host, probe);
      palette = buildPalette(theme);
      if (m) atlas.reset(m);
      full = true;
      relayout();
    };

    const ro = new ResizeObserver(relayout);
    ro.observe(host);
    const unwatch = watchTheme(retheme);
    // The theme's face may still be loading: its metrics change when it lands.
    void document.fonts?.ready.then(() => { if (!disposed) { m = null; relayout(); } });

    layout();
    if (animating) raf = requestAnimationFrame(tick);
    else paintOnce();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      unwatch();
      requestRef.current = () => {};
    };
  }, [fps, still, glow, lineHeight]);

  useEffect(() => { requestRef.current(); }, [frame]);

  return (
    // A span (display: block) so a drawing can sit inside a <button>.
    <span ref={hostRef} className={cn('relative block overflow-hidden', className)} aria-hidden="true">
      {glow && <canvas ref={glowRef} className={cn('absolute top-0 left-0', styles.glow)} />}
      <canvas ref={canvasRef} className="absolute top-0 left-0" />
    </span>
  );
}
