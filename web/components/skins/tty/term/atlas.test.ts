// The atlas holds every glyph a drawing blits, and iOS caps the canvas
// memory a page may hold: it starts small and grows only when it fills,
// keeps each glyph where it was as it grows, and wipes rather than
// reallocates when its size hasn't changed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATLAS_SLOTS_PER_ROW, GlyphAtlas, atlasRows } from './atlas';
import type { GlyphMetrics } from './glyphs';

interface FakeCanvas {
  width: number;
  height: number;
  /** Bitmap (re)allocations: every assignment to width or height. */
  allocations: number;
  calls: string[];
}

/** Just enough canvas to draw into: it counts allocations and logs calls. */
function fakeCanvas(): FakeCanvas {
  let width = 0;
  let height = 0;
  const c = {
    allocations: 0,
    calls: [] as string[],
    get width() { return width; },
    set width(v: number) { width = v; c.allocations++; },
    get height() { return height; },
    set height(v: number) { height = v; c.allocations++; },
    getContext: () => ctx,
  };
  const ctx = new Proxy({}, {
    get: (_t, name) => () => { c.calls.push(String(name)); },
    set: () => true,
  });
  return c;
}

function harness() {
  const made: FakeCanvas[] = [];
  const atlas = new GlyphAtlas(() => {
    const c = fakeCanvas();
    made.push(c);
    return c as unknown as HTMLCanvasElement;
  });
  return { atlas, made };
}

const metrics = (w: number, h: number): GlyphMetrics => ({ w, h, font: `500 ${h}px mono`, baseline: h - 4, stroke: 2 });
const A = 'A'.codePointAt(0)!;

test('an atlas starts around 512px tall and is capped at 4096', () => {
  assert.deepEqual(atlasRows(36), { start: 14, max: 113 });
  assert.deepEqual(atlasRows(16), { start: 32, max: 256 });
  // A huge cell still gets room to grow into.
  assert.deepEqual(atlasRows(600), { start: 2, max: 8 });
  assert.equal(atlasRows(0).max, 4096);
});

test('it starts small, then doubles as it fills, keeping every slot', () => {
  const { atlas, made } = harness();
  const m = metrics(18, 36);
  atlas.reset(m);
  assert.equal(atlas.canvas.width, ATLAS_SLOTS_PER_ROW * 18 * 2);
  assert.equal(atlas.canvas.height, 14 * 36);

  const capacity = 14 * ATLAS_SLOTS_PER_ROW;
  const first = atlas.locate(A, 3, '#fff');
  for (let k = 0; atlas.canvas.height === 14 * 36; k++) atlas.locate(0x2500 + k, 0, '#fff');
  const generation = atlas.generation;

  assert.equal(atlas.canvas.height, 28 * 36, 'doubled');
  assert.equal(made.length, 2);
  assert.ok(made[1]!.calls.includes('drawImage'), 'the old glyphs were copied across');
  assert.equal(made[0]!.width, 0, 'and the old bitmap handed back');
  assert.equal(atlas.locate(A, 3, '#fff'), first, 'a glyph already drawn keeps its slot');
  assert.equal(atlas.generation, generation);
  assert.equal(atlas.y(capacity), 14 * 36, 'the next slot lands in the new rows');
});

test('at the cap it starts over, keeping its size, and says so', () => {
  const { atlas } = harness();
  atlas.reset(metrics(10, 600)); // 2 rows, growing to 8
  const generation = atlas.generation;
  for (let k = 0; k < 8 * ATLAS_SLOTS_PER_ROW; k++) atlas.locate(0x2500 + k, 0, '#fff');
  assert.equal(atlas.generation, generation, 'growing drops nothing');
  assert.equal(atlas.locate(A, 0, '#fff'), 0, 'full: back to the first slot');
  assert.equal(atlas.generation, generation + 1);
  assert.equal(atlas.canvas.height, 8 * 600);
});

test('a reset for the same cell wipes the canvas instead of reallocating it', () => {
  const { atlas, made } = harness();
  atlas.reset(metrics(18, 36));
  const allocations = made[0]!.allocations;
  atlas.locate(A, 1, '#fff');
  atlas.reset({ ...metrics(18, 36), font: '500 36px other' });
  assert.equal(made[0]!.allocations, allocations);
  assert.equal(made[0]!.calls.at(-1), 'clearRect');
  assert.equal(atlas.locate(A, 1, '#000'), 0, 'every slot was dropped');

  // A new cell size is a new canvas size.
  atlas.reset(metrics(20, 40));
  assert.equal(atlas.canvas.width, ATLAS_SLOTS_PER_ROW * 20 * 2);
  assert.equal(atlas.canvas.height, 12 * 40);
});

test('release hands the bitmap back', () => {
  const { atlas } = harness();
  atlas.reset(metrics(18, 36));
  atlas.release();
  assert.equal(atlas.canvas.width, 0);
  assert.equal(atlas.canvas.height, 0);
});
