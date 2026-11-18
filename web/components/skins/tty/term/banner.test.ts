// The banner's size is chosen from one measurement of each line, before
// anything is drawn: a candidate too wide is turned away on arithmetic, and
// the order of retreat — more lines, then a condensed face, then smaller
// letters — holds without a canvas in sight (this file runs in Node).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bannerLayout, planBanner, type BannerInk } from './banner';

/** A face whose capitals are 60 wide and 70 tall at the 100px probe. */
const ink = (line: string): BannerInk => ({ left: 0, right: 60 * [...line].length, ascent: 70, descent: 0, chars: [...line].length });
const ASPECT = 0.5;
const cols = (line: string, rows: number, squeeze = 1) => bannerLayout(ink(line), rows, ASPECT, squeeze).cols;

test('a line widens with its letters and narrows when condensed', () => {
  assert.ok(cols('ABCD', 6) > cols('ABCD', 3));
  assert.ok(cols('ABCD', 6, 0.74) < cols('ABCD', 6));
  const l = bannerLayout(ink('ABCD'), 6, ASPECT, 1);
  assert.equal(l.cols, Math.ceil(l.subCols / 2), 'two sub-pixels to a cell');
});

test('a title that fits goes full size on one line', () => {
  assert.deepEqual(planBanner('HI', ink, ASPECT, 200, 6), { lines: ['HI'], rows: 6, squeeze: 1 });
});

test('it wraps onto more lines before condensing or shrinking', () => {
  const maxCols = cols('AAAA', 6);
  assert.ok(cols('AAAA BBBB', 6, 0.74) > maxCols);
  assert.deepEqual(planBanner('AAAA BBBB', ink, ASPECT, maxCols, 6), { lines: ['AAAA', 'BBBB'], rows: 6, squeeze: 1 });
});

test('one long word condenses before it shrinks, then shrinks', () => {
  const word = 'ABCDEFGHIJ';
  assert.deepEqual(planBanner(word, ink, ASPECT, cols(word, 6, 0.74), 6), { lines: [word], rows: 6, squeeze: 0.74 });
  const small = cols(word, 4, 0.74);
  assert.ok(cols(word, 5, 0.74) > small && cols(word, 4) > small);
  assert.deepEqual(planBanner(word, ink, ASPECT, small, 6), { lines: [word], rows: 4, squeeze: 0.74 });
});

test('nothing that fits, or nothing with ink, is no banner', () => {
  assert.equal(planBanner('ABCDEFGHIJ', ink, ASPECT, 2, 6), null);
  assert.equal(planBanner('ABC', () => null, ASPECT, 200, 6), null);
});

test('each candidate is measured, never drawn', () => {
  const seen: string[] = [];
  planBanner('AAAA BBBB CCCC', l => { seen.push(l); return ink(l); }, ASPECT, cols('AAAA', 3), 6);
  assert.ok(seen.length > 3, 'many sizes were weighed');
  assert.ok(seen.every(l => ['AAAA BBBB CCCC', 'AAAA BBBB', 'AAAA', 'BBBB', 'CCCC', 'BBBB CCCC'].includes(l)));
});
