// A skin's in-drawing legends are squeezed to fit after they're drawn, and
// every measure after a write costs a layout, so both the outcome and the
// one layout per pass are pinned here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitSvgTexts, type FitText } from './svgTextFit';

/** A page of `<text>` rows sharing one layout: any write dirties it, and a
 *  measure while it's dirty forces a layout. A squeezed row measures its
 *  squeeze, as a browser's does. */
function page() {
  const state = { dirty: false, layouts: 0 };
  const row = (natural: number, room: number, squeezed?: number): FitText & { attrs: Map<string, string> } => {
    const attrs = new Map<string, string>();
    if (squeezed != null) {
      attrs.set('textLength', String(squeezed));
      attrs.set('lengthAdjust', 'spacingAndGlyphs');
    }
    return {
      attrs,
      dataset: { fit: String(room) },
      hasAttribute: n => attrs.has(n),
      setAttribute: (n, v) => { attrs.set(n, v); state.dirty = true; },
      removeAttribute: n => { attrs.delete(n); state.dirty = true; },
      getComputedTextLength: () => {
        if (state.dirty) { state.layouts++; state.dirty = false; }
        const t = attrs.get('textLength');
        return t == null ? natural : Number(t);
      },
    };
  };
  return { state, row };
}

test('rows that run over are squeezed to their room, the rest left alone', () => {
  const { row } = page();
  const long = row(140, 100);
  const short = row(80, 100);
  fitSvgTexts([long, short]);
  assert.equal(long.attrs.get('textLength'), '100');
  assert.equal(long.attrs.get('lengthAdjust'), 'spacingAndGlyphs');
  assert.equal(short.attrs.size, 0);
});

test('a squeezed row that now fits loses its squeeze', () => {
  // Measured with its old squeeze on, it would read as exactly its room and
  // keep a squeeze it no longer needs, stretched wider than it is.
  const { row } = page();
  const was = row(60, 100, 100);
  fitSvgTexts([was]);
  assert.equal(was.attrs.size, 0);
});

test('a pass forces one layout however many rows it measures', () => {
  const { state, row } = page();
  const rows = [row(140, 100, 100), row(80, 100), row(120, 90, 90), row(50, 60, 60), row(10, 20)];
  fitSvgTexts(rows);
  assert.equal(state.layouts, 1);
});

test('rows that carry no squeeze are measured without a write first', () => {
  const { state, row } = page();
  fitSvgTexts([row(80, 100), row(30, 40)]);
  assert.equal(state.layouts, 0);
});

test('a hidden row measures zero and stays unsqueezed', () => {
  const { row } = page();
  const hidden = row(0, 100);
  fitSvgTexts([hidden]);
  assert.equal(hidden.attrs.size, 0);
});
