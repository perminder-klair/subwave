// The scope pane's instruments draw into a region of a shared grid, so the
// one promise that matters is that they stay inside it — at any size, loud
// or silent — and never throw on a pane too small to hold them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Grid, SPACE } from './term/grid';
import { STILL_SIGNAL, createSignal } from './term/signal';
import { INSTRUMENTS, createInstrumentState, drawInstrument, hzToCol, isInstrument } from './instruments';

test('every instrument stays inside its area', () => {
  const area = { x: 5, y: 3, w: 70, h: 9 };
  const loud = { ...STILL_SIGNAL, onset: 1 };
  for (const { id } of INSTRUMENTS) {
    const st = createInstrumentState();
    const g = new Grid(80, 15);
    for (let f = 0; f < 60; f++) drawInstrument(id, g, loud, f / 30, st, area);
    let inside = 0;
    for (let y = 0; y < g.rows; y++) {
      for (let x = 0; x < g.cols; x++) {
        if (g.get(x, y) === SPACE) continue;
        const within = x >= area.x && x < area.x + area.w && y >= area.y && y < area.y + area.h;
        assert.ok(within, `${id} drew at ${x},${y}`);
        inside++;
      }
    }
    assert.ok(inside > 20, `${id} drew almost nothing`);
  }
});

test('silence still shows a resting instrument', () => {
  for (const { id } of INSTRUMENTS) {
    const g = new Grid(60, 6);
    drawInstrument(id, g, createSignal(), 1, createInstrumentState());
    assert.ok(g.chars.some(cp => cp !== SPACE), `${id} is blank at rest`);
  }
});

test('a pane too small to hold an instrument is not an error', () => {
  for (const { id } of INSTRUMENTS) {
    for (const [w, h] of [[0, 0], [1, 1], [3, 1], [1, 4]] as const) {
      drawInstrument(id, new Grid(w, h), STILL_SIGNAL, 2, createInstrumentState());
    }
  }
});

test('the frequency axis is logarithmic', () => {
  assert.equal(hzToCol(40, 101), 0);
  assert.equal(hzToCol(16000, 101), 100);
  // 40 Hz → 16 kHz spans ~8.6 octaves, so 1 kHz lands just past half way.
  const k = hzToCol(1000, 101);
  assert.ok(k > 50 && k < 60, `1 kHz at ${k}`);
});

test('a stored instrument is only honoured when it names one', () => {
  assert.equal(isInstrument('scope'), true);
  assert.equal(isInstrument('oscilloscope'), false);
  assert.equal(isInstrument(null), false);
});
