// Unit tests for the Stats page's tuner dial.
// Same lightweight harness as statsHealth.test.ts. Run from web/:
// `npm test -- statsDial`.

import assert from 'node:assert/strict';
import { dialPosition, readingLine, stationAt, type DialPage } from './statsDial';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

// A 900px viewport over a page whose sections start 1000px apart, read part way
// down: `scrolled` shifts every edge up, as the browser reports them.
const page = (scrolled: number, over: Partial<DialPage> = {}): DialPage => ({
  tops: [200, 1200, 2200, 3200].map(top => top - scrolled),
  end: 4000 - scrolled,
  rest: 120,
  viewport: 900,
  scrolled,
  remaining: 3100 - scrolled,
  ...over,
});

console.log('stats dial:');

test('the top of the page rests on the first station', () => {
  assert.equal(dialPosition(page(0)), 0);
});

test('a section reads from its top edge reaching the line', () => {
  assert.equal(dialPosition(page(1080)), 1);
  assert.equal(dialPosition(page(1081)) > 1, true);
  assert.equal(dialPosition(page(1079)) < 1, true);
});

test('the needle moves through a section in proportion', () => {
  assert.equal(dialPosition(page(1580)), 1.5);
});

test('the line holds still until the final screenful of scroll', () => {
  const inputs = { rest: 120, viewport: 900, scrolled: 1000, remaining: 900 };
  assert.equal(readingLine(inputs), 120);
  assert.equal(readingLine({ ...inputs, remaining: 450 }), 510);
  assert.equal(readingLine({ ...inputs, remaining: 0 }), 900);
});

test('the bottom of the page reaches the last section, which never meets the rest line', () => {
  // A short tail: at full scroll the last section's top sits at 800, under the
  // resting line's reach, so without the sweep the needle would stop a station early.
  const tail: DialPage = {
    tops: [-2000, -900, 800],
    end: 900,
    rest: 120,
    viewport: 900,
    scrolled: 2200,
    remaining: 0,
  };
  assert.equal(stationAt(dialPosition(tail), 3), 2);
  assert.equal(dialPosition(tail), 3);
});

test('a page with nothing to scroll stays on the first station', () => {
  const short = page(0, { remaining: 0, tops: [200, 500], end: 700 });
  assert.equal(readingLine(short), 120);
  assert.equal(dialPosition(short), 0);
});

test('two sections on the same edge do not divide by zero', () => {
  const stacked = page(0, { tops: [100, 100, 500], end: 900 });
  assert.equal(dialPosition(stacked), 1 + 20 / 400);
  const collapsed = page(0, { tops: [100], end: 100 });
  assert.equal(dialPosition(collapsed), 0);
});

test('the far end of the scale is still the last station', () => {
  assert.equal(stationAt(0, 7), 0);
  assert.equal(stationAt(3.9, 7), 3);
  assert.equal(stationAt(7, 7), 6);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll statsDial tests passed.');
