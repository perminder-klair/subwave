// The focus screen's card is laid out by character budget before the scene
// measures anything, so the budget's promises are pinned here: nothing runs
// out of the window, and the title never shoves into the progress bar.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LID_SHEET } from './geometry';
import { SCREEN, clip, screenLayout, titleFit, wrapLines, type LidScreenInfo } from './screen';

const base: LidScreenInfo = {
  eyebrow: 'now playing — side a',
  onAir: false,
  title: 'Wildly Sexy',
  artist: 'HiGhMaS',
  detail: 'Highmas 2 · 2021',
  elapsed: '1:02',
  duration: '3:45',
  ratio: 0.27,
  foot: { kind: 'next', text: 'Reflections — Triplexity' },
};

test('the screen window sits on glass no wall stands in front of', () => {
  const { x0, y0, x1, y1 } = LID_SHEET.clear;
  assert.ok(SCREEN.x >= x0 && SCREEN.y >= y0, 'window starts under a wall');
  assert.ok(SCREEN.x + SCREEN.w <= x1 && SCREEN.y + SCREEN.h <= y1, 'window runs under a wall');
});

test('wrapLines keeps every line inside its budget', () => {
  assert.deepEqual(wrapLines('Inspiring Future Bass', 12), ['Inspiring', 'Future Bass']);
  assert.deepEqual(wrapLines('  spaced   out  ', 20), ['spaced out']);
  assert.deepEqual(wrapLines('Supercalifragilistic', 8), ['Supercal', 'ifragili', 'stic']);
  const cut = wrapLines('one two three four five six seven', 9, 2);
  assert.equal(cut.length, 2);
  assert.ok(cut[1]!.endsWith('…'));
  for (const line of cut) assert.ok(line.length <= 9, line);
});

test('clip only cuts what runs over', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('exactly10!', 10), 'exactly10!');
  assert.equal(clip('a much longer line', 8), 'a much…');
});

test('a short title gets one big line, a long one two smaller lines', () => {
  const short = titleFit('Wildly Sexy');
  assert.equal(short.lines.length, 1);
  const medium = titleFit('Inspiring Future Bass');
  assert.ok(medium.size < short.size && medium.lines.length === 2);
  const long = titleFit('The Ballad of the Very Long Song Title That Keeps Going Past Any Reasonable Window');
  assert.ok(long.size <= medium.size && long.lines.length <= 2);
  assert.ok(long.lines[long.lines.length - 1]!.endsWith('…'));
});

test('every row lands inside the window, top block clear of the progress bar', () => {
  const titles = ['X', 'Wildly Sexy', 'Inspiring Future Bass', 'A Title Long Enough To Need The Smallest Size Of All', 'Ü'.repeat(80)];
  for (const title of titles) {
    for (const foot of [base.foot, null, { kind: 'quote' as const, text: 'Coming up after this, a little something for the night owls.' }]) {
      const L = screenLayout({ ...base, title, foot });
      const lastTop = L.detail ?? L.artist ?? L.title.rows[L.title.rows.length - 1]!;
      assert.ok(lastTop.y + 3 <= L.bar.y, `"${title}" runs into the bar (${lastTop.y} vs ${L.bar.y})`);
      const rows = [L.eyebrow, ...L.title.rows, L.artist, L.detail, L.foot].filter(r => r != null);
      for (const r of rows) {
        assert.ok(r.y > SCREEN.y && r.y <= SCREEN.y + SCREEN.h, `row "${r.text}" at ${r.y} is outside the window`);
      }
      assert.ok(L.timeY <= SCREEN.y + SCREEN.h && L.bar.y + L.bar.h < L.timeY);
    }
  }
});

test('the bar leaves room for its readings, however long they run', () => {
  for (const [elapsed, duration] of [['0:04', '3:45'], ['--:--', 'live'], ['1:02:33', '1:14:09']]) {
    const L = screenLayout({ ...base, elapsed: elapsed!, duration: duration! });
    // A mono reading is at most 0.66 em a character at this size and tracking.
    const reading = Math.max(elapsed!.length, duration!.length) * 6.5 * 0.66;
    assert.ok(L.bar.x >= SCREEN.x + reading, `bar starts under "${elapsed}"`);
    assert.ok(L.bar.x + L.bar.w <= SCREEN.x + SCREEN.w - reading, `bar ends under "${duration}"`);
    assert.ok(L.bar.w > SCREEN.w / 2, 'bar shrank to a stub');
  }
});

test('missing facts drop their rows rather than printing blanks', () => {
  const L = screenLayout({ ...base, artist: '', detail: '', foot: null });
  assert.equal(L.artist, null);
  assert.equal(L.detail, null);
  assert.equal(L.foot, null);
});
