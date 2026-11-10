// Focus mode's windows: the card sits clear of the grid's edges at any
// size, the caption keeps out of its way, and the typewriter shows a
// prefix with one cursor — never a cursor on every line.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Grid, SPACE, WIDE_TAIL } from './term/grid';
import { STILL_SIGNAL } from './term/signal';
import { splitLines } from './term/banner';
import { cardHeight, drawCaption, drawNowPlaying, type StageInfo } from './focus';

const INFO: StageInfo = {
  title: 'Brandy in the Night',
  byline: 'Giorgio Ghiglieri — Insonnia · 2014',
  facts: 'JAZZ · 162 BPM · 7B · romantic',
  elapsed: '0:42',
  duration: '2:00',
  ratio: 0.35,
  status: 'on air',
  live: true,
};

const text = (g: Grid) => {
  const lines: string[] = [];
  for (let y = 0; y < g.rows; y++) {
    lines.push(Array.from(g.chars.subarray(y * g.cols, (y + 1) * g.cols), cp => (cp === WIDE_TAIL ? '' : String.fromCodePoint(cp))).join(''));
  }
  return lines.join('\n');
};

test('the card fits the grid it is drawn on, bottom-left or full-width', () => {
  for (const [cols, rows, full] of [[160, 42, false], [62, 40, true], [40, 14, false]] as const) {
    const g = new Grid(cols, rows);
    const top = drawNowPlaying(g, INFO, null, STILL_SIGNAL, full);
    assert.ok(top >= 0);
    assert.ok(top + cardHeight(INFO, null) <= rows, `${cols}×${rows} card runs off the bottom`);
    assert.match(text(g), /now playing/);
    assert.match(text(g), /BRANDY IN THE NIGHT/);
    assert.match(text(g), /0:42 \/ 2:00/);
  }
});

test('a live stream with no duration says so instead of a bar', () => {
  const g = new Grid(120, 30);
  drawNowPlaying(g, { ...INFO, ratio: null }, null, STILL_SIGNAL);
  assert.match(text(g), /0:42 · live/);
});

test('the caption types a prefix, with one cursor where typing has reached', () => {
  const g = new Grid(100, 40);
  drawCaption(g, { who: 'Nova', text: 'late hours here on the station, snow outside and the kettle on' }, 12, 30);
  const out = text(g);
  assert.match(out, /NOVA ●/);
  assert.match(out, /“late hours/);
  assert.doesNotMatch(out, /snow/);
  assert.equal(out.split('▌').length - 1, 1);
});

test('the caption stands aside when the grid is too short to hold it clear of the card', () => {
  const g = new Grid(100, 12);
  drawCaption(g, { who: 'Nova', text: 'hello there' }, Infinity, 5);
  assert.ok(g.chars.every(cp => cp === SPACE));
});

test('banner lines break at words, as evenly as they can', () => {
  assert.deepEqual(splitLines('leave and never look back', 1), ['leave and never look back']);
  assert.deepEqual(splitLines('leave and never look back', 2), ['leave and', 'never look back']);
  assert.equal(splitLines('leave and never look back', 3)!.length, 3);
  assert.equal(splitLines('one two', 3), null);
  assert.deepEqual(splitLines('  spaced   out  ', 2), ['spaced', 'out']);
});
