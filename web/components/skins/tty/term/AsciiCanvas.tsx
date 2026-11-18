'use client';

// The one painter for every character drawing in the TTY skin. It sizes a
// Grid to its box the way a terminal answers SIGWINCH, hands it to `paint`,
// and puts the result on a canvas:
//
//  - Glyphs are rendered once per (code point, colour) into an atlas
//    (atlas.ts) and blitted from there, and only cells that changed since the
//    last frame are repainted (damage.ts) — a full-window scene is ~10k
//    cells, and fillText per cell per frame is what that would otherwise
//    cost. A frame draws every new glyph into the atlas before it blits any:
//    interleaved, WebKit flushes the atlas's pending drawing before each blit
//    that reads it.
//  - Colours come from the theme tokens (see palette.ts), re-read when the
//    theme changes under us: the provider writes them onto <html>, so one
//    MutationObserver there catches every switch. It also catches writes
//    that change nothing, so the atlas is only redrawn for new colours.
//  - With `glow`, cells whose colour blooms are also painted onto a second
//    canvas under the first that CSS blurs — the phosphor halo, at the cost
//    of a compositor filter rather than a per-glyph shadow. Under a 5px blur
//    device pixels are invisible, so that canvas has one pixel per CSS pixel:
//    a quarter of the memory and the fill on a 2× iPad.
//  - `still` (lite mode, reduced motion) paints one frame at `stillAt` and
//    no loop runs; it repaints only on resize, theme or `frame` change.
//  - `paused` (hidden behind something opaque) schedules no frames at all,
//    keeping everything built, and paints afresh when it lifts.
//
// Unmounting hands every bitmap back at once: iOS counts canvas memory
// against a page-wide cap until the GC gets round to it, and past the cap a
// canvas silently draws nothing.

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { Grid, SPACE, WIDE_TAIL, cellWidth } from './grid';
import { createColorProbe, readThemeRgb, sameThemeRgb, watchTheme } from '@/lib/theme-rgb';
import { buildPalette, glows, isDarkTheme, type ThemeRgb } from './palette';
import type { GlyphMetrics } from './glyphs';
import { GlyphAtlas } from './atlas';
import { FULL_REDRAW_SHARE, cellEdges, forEachRun, markDamage } from './damage';
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
  /** Covered: paint nothing until it lifts. Unlike `still`, changing it
   *  rebuilds nothing. */
  paused?: boolean;
  className?: string;
}

/** A canvas's bitmap and its box. The bitmap only when its size changed:
 *  assigning `width` reallocates even at the same size. */
function place(c: HTMLCanvasElement, w: number, h: number, cssW: number, cssH: number, left: string, top: string): void {
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
  c.style.left = left;
  c.style.top = top;
}

export default function AsciiCanvas({
  paint, fontSize, fps = 20, still = false, stillAt = 0, frame, lineHeight = 1.2, glow = false, paused = false, className,
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
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const requestRef = useRef<() => void>(() => {});
  const resumeRef = useRef<() => void>(() => {});

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
    let slots = new Int32Array(0);
    // Cells with a glyph on the glow canvas (both halves of a wide one), and
    // scratch for the changed ones among them: only those need clearing there.
    let glowed = new Uint8Array(0);
    let unglow = new Uint8Array(0);
    // Cell edges on the glow canvas, which is drawn at a smaller scale.
    let gx: Int32Array = new Int32Array(0);
    let gy: Int32Array = new Int32Array(0);
    let full = true;
    let theme = readThemeRgb(host, probe);
    let palette = buildPalette(theme);
    let m: GlyphMetrics | null = null;
    // The face as measured, not as named: when the theme's font lands it keeps
    // its name, and often the cell size, while every glyph changes.
    let face = '';
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
      const baseline = Math.round((h - (ascent + descent)) / 2 + ascent);
      const stroke = Math.max(1, Math.round(dpr));
      const measured = `${font}|${tm.width}|${ascent}|${descent}`;
      const cellChanged = !m || m.w !== w || m.h !== h || m.baseline !== baseline || m.stroke !== stroke || face !== measured;
      // The atlas outlives a resize that keeps the cell: its glyphs still fit.
      if (cellChanged) {
        m = { w, h, font, baseline, stroke };
        face = measured;
        atlas.reset(m);
      }
      if (cellChanged || grid.cols !== cols || grid.rows !== rows) {
        const n = cols * rows;
        grid = new Grid(cols, rows);
        prevChars = new Uint32Array(n);
        prevInk = new Uint16Array(n);
        marks = new Uint8Array(n);
        slots = new Int32Array(n);
        glowed = new Uint8Array(n);
        unglow = new Uint8Array(n);
        // Centred: the box rarely divides into whole cells, and an even
        // margin reads as a terminal window rather than a cropped one.
        const left = `${Math.floor((rect.width - (cols * w) / dpr) / 2)}px`;
        const top = `${Math.floor((rect.height - (rows * h) / dpr) / 2)}px`;
        place(canvas, cols * w, rows * h, (cols * w) / dpr, (rows * h) / dpr, left, top);
        if (glowCanvas) {
          const s = Math.min(1, 1 / dpr);
          // One column past the edge, for a wide glyph in the last one.
          gx = cellEdges(cols + 1, w, s);
          gy = cellEdges(rows, h, s);
          place(glowCanvas, gx[cols]!, gy[rows]!, gx[cols]! / (s * dpr), gy[rows]! / (s * dpr), left, top);
        }
        full = true;
      }
      env = { cellW: w / dpr, cellH: h / dpr, fontFamily: family, theme, dark: isDarkTheme(theme) };
      return true;
    };

    const clearRun = (i: number, len: number) => {
      const c = i % grid.cols;
      ctx.clearRect(c * m!.w, ((i - c) / grid.cols) * m!.h, len * m!.w, m!.h);
    };
    const clearGlowRun = (i: number, len: number) => {
      const c = i % grid.cols;
      const r = (i - c) / grid.cols;
      gctx!.clearRect(gx[c]!, gy[r]!, gx[c + len]! - gx[c]!, gy[r + 1]! - gy[r]!);
    };

    const flush = () => {
      if (!m) return;
      const { w, h } = m;
      const { cols, chars, ink } = grid;
      const n = chars.length;
      const dirty = full ? n : markDamage(chars, ink, prevChars, prevInk, marks);
      full = false;
      if (dirty === 0) return;
      if (dirty > n * FULL_REDRAW_SHARE) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (gctx) {
          gctx.clearRect(0, 0, gctx.canvas.width, gctx.canvas.height);
          glowed.fill(0);
        }
        marks.fill(1);
      } else {
        forEachRun(marks, cols, clearRun);
        if (gctx) {
          for (let i = 0; i < n; i++) {
            const u = marks[i]! & glowed[i]!;
            unglow[i] = u;
            if (u) glowed[i] = 0;
          }
          forEachRun(unglow, cols, clearGlowRun);
        }
      }

      // Every glyph this frame needs goes into the atlas first…
      const generation = atlas.generation;
      for (let i = 0; i < n; i++) {
        const cp = chars[i]!;
        if (!marks[i] || cp === SPACE || cp === WIDE_TAIL) continue;
        const k = ink[i]!;
        slots[i] = atlas.locate(cp, k, palette[k] ?? palette[0]!);
      }
      // …unless it filled and started over part-way, dropping slots already
      // found: then this frame locates each glyph as it blits, as it once did.
      const settled = atlas.generation === generation;

      for (let i = 0; i < n; i++) {
        if (!marks[i]) continue;
        const cp = chars[i]!;
        const k = ink[i]!;
        prevChars[i] = cp;
        prevInk[i] = k;
        if (cp === SPACE || cp === WIDE_TAIL) continue;
        const slot = settled ? slots[i]! : atlas.locate(cp, k, palette[k] ?? palette[0]!);
        const sx = atlas.x(slot);
        const sy = atlas.y(slot);
        const wide = cellWidth(cp) === 2;
        const sw = wide ? w * 2 : w;
        const c = i % cols;
        const r = (i - c) / cols;
        ctx.drawImage(atlas.canvas, sx, sy, sw, h, c * w, r * h, sw, h);
        if (gctx && glows(k)) {
          const x0 = gx[c]!;
          const y0 = gy[r]!;
          gctx.drawImage(atlas.canvas, sx, sy, sw, h, x0, y0, gx[c + (wide ? 2 : 1)]! - x0, gy[r + 1]! - y0);
          glowed[i] = 1;
          if (wide && c + 1 < cols) glowed[i + 1] = 1;
        }
      }
    };

    const paintAt = (t: number) => {
      if (!env || grid.cols === 0 || grid.rows === 0) return;
      grid.clear();
      paintRef.current(grid, t, env);
      flush();
    };

    const animating = fps > 0 && !still;
    const tick = (now: number) => {
      raf = 0;
      if (disposed || pausedRef.current) return;
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / fps - 2) return;
      last = now;
      paintAt((now - t0) / 1000);
    };
    const paintOnce = () => {
      if (pausedRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!disposed && !pausedRef.current) paintAt(still ? stillAtRef.current : (performance.now() - t0) / 1000);
      });
    };
    /** Paint now: the loop from a fresh frame, or the one frame there is. */
    const start = () => {
      if (disposed || pausedRef.current) return;
      if (!animating) { paintOnce(); return; }
      last = -Infinity;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    requestRef.current = () => { if (!animating) paintOnce(); };
    resumeRef.current = start;

    // Repaints only when the layout invalidated what's on the canvas.
    const relayout = () => {
      if (!layout() || !full) return;
      if (animating) last = -Infinity;
      else paintOnce();
    };
    const retheme = () => {
      const next = readThemeRgb(host, probe);
      if (!sameThemeRgb(next, theme)) {
        theme = next;
        palette = buildPalette(theme);
        if (m) atlas.reset(m);
        full = true;
      }
      // Same colours can still be a new face.
      relayout();
    };

    const ro = new ResizeObserver(relayout);
    ro.observe(host);
    const unwatch = watchTheme(retheme);
    // The theme's face may still be loading: re-measured when it lands, and
    // the atlas redrawn only if it measures differently.
    void document.fonts?.ready.then(() => { if (!disposed) relayout(); });

    layout();
    start();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      unwatch();
      requestRef.current = () => {};
      resumeRef.current = () => {};
      atlas.release();
      for (const c of glowCanvas ? [canvas, glowCanvas] : [canvas]) c.width = c.height = 0;
    };
  }, [fps, still, glow, lineHeight]);

  useEffect(() => { requestRef.current(); }, [frame]);
  useEffect(() => { if (!paused) resumeRef.current(); }, [paused]);

  return (
    // A span (display: block) so a drawing can sit inside a <button>.
    <span ref={hostRef} className={cn('relative block overflow-hidden', className)} aria-hidden="true">
      {glow && <canvas ref={glowRef} className={cn('absolute top-0 left-0', styles.glow)} />}
      <canvas ref={canvasRef} className="absolute top-0 left-0" />
    </span>
  );
}
