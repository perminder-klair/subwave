// The glyph atlas AsciiCanvas blits from: each (code point, colour) drawn
// once, two cells wide per slot so a wide glyph fits.
//
// It starts small and doubles when it fills, up to a cap, and only at the cap
// starts over. A full-window scene uses a few hundred glyphs, while iOS caps
// the canvas memory a page may hold and fails silently past it: an atlas
// sized for thousands up front was 10–19 MB apiece at 2×, for slots it never
// filled. For the same reason a reset whose size hasn't changed clears the
// canvas rather than resizing it — assigning `width` reallocates the bitmap
// even at the same size.

import { drawGlyph, type GlyphMetrics } from './glyphs';

/** Slots across one atlas row. */
export const ATLAS_SLOTS_PER_ROW = 32;
/** Roughly how tall an atlas starts, and the most it grows to, in pixels. */
const START_PX = 512;
const MAX_PX = 4096;

/** Slot rows an atlas for cells `h` pixels tall starts with, and its cap. */
export function atlasRows(h: number): { start: number; max: number } {
  const cell = Math.max(1, h);
  const max = Math.max(8, Math.floor(MAX_PX / cell));
  return { start: Math.min(max, Math.max(2, Math.floor(START_PX / cell))), max };
}

export class GlyphAtlas {
  canvas: HTMLCanvasElement;
  /** Bumped whenever every slot is dropped: a slot found before it is gone. */
  generation = 0;
  private ctx: CanvasRenderingContext2D;
  private slots = new Map<number, number>();
  private next = 0;
  private rows = 0;
  private maxRows = 0;
  private m: GlyphMetrics | null = null;

  constructor(private readonly create: () => HTMLCanvasElement = () => document.createElement('canvas')) {
    this.canvas = create();
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** Empty, for glyphs of metrics `m`. */
  reset(m: GlyphMetrics): void {
    const sameCell = this.rows > 0 && this.m?.w === m.w && this.m.h === m.h;
    this.m = m;
    this.slots.clear();
    this.next = 0;
    this.generation++;
    const { start, max } = atlasRows(m.h);
    this.maxRows = max;
    if (sameCell) {
      // Keeps whatever size it grew to: it was needed once.
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    this.rows = start;
    this.canvas.width = ATLAS_SLOTS_PER_ROW * m.w * 2;
    this.canvas.height = start * m.h;
  }

  /** The slot holding a glyph, drawing it there on first use. */
  locate(cp: number, inkIndex: number, color: string): number {
    const key = cp * 512 + inkIndex;
    let slot = this.slots.get(key);
    if (slot !== undefined) return slot;
    const m = this.m!;
    if (this.next >= this.rows * ATLAS_SLOTS_PER_ROW) {
      if (this.rows < this.maxRows) this.grow(m);
      else this.reset(m);
    }
    slot = this.next++;
    this.slots.set(key, slot);
    const sx = this.x(slot);
    const sy = this.y(slot);
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(sx, sy, m.w * 2, m.h);
    this.ctx.clip();
    drawGlyph(this.ctx, cp, sx, sy, m, color);
    this.ctx.restore();
    return slot;
  }

  /** A slot's origin on the canvas. */
  x(slot: number): number {
    return (slot % ATLAS_SLOTS_PER_ROW) * this.m!.w * 2;
  }

  y(slot: number): number {
    return Math.floor(slot / ATLAS_SLOTS_PER_ROW) * this.m!.h;
  }

  /** Hands the bitmap back now rather than at the next GC. */
  release(): void {
    this.canvas.width = this.canvas.height = 0;
    this.slots.clear();
    this.rows = 0;
    this.m = null;
  }

  /** Twice the rows, up to the cap, on a fresh canvas with the old one copied
   *  in, so every slot keeps its place. */
  private grow(m: GlyphMetrics): void {
    const rows = Math.min(this.maxRows, this.rows * 2);
    const bigger = this.create();
    bigger.width = this.canvas.width;
    bigger.height = rows * m.h;
    const ctx = bigger.getContext('2d')!;
    ctx.drawImage(this.canvas, 0, 0);
    this.canvas.width = this.canvas.height = 0;
    this.canvas = bigger;
    this.ctx = ctx;
    this.rows = rows;
  }
}
