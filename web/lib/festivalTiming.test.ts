// The Festivals panel's badge runs the controller's rule (#2112). This is the
// same case table as controller/scripts/festival-range.test.ts, run through
// the panel's own entry point on browser-local dates.
// Run from web/: `npm test -- festivalTiming`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { festivalSpanLabel, festivalTiming, type FestivalDates } from './festivalTiming';

const local = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 12);
};

const CASES: Record<string, { f: FestivalDates; on: string[]; off: string[] }> = {
  'single day, no window': {
    f: { month: 12, day: 25 },
    on: ['2026-12-25'],
    off: ['2026-12-24', '2026-12-26'],
  },
  'window spans the year boundary': {
    f: { month: 1, day: 1, windowDays: 3 },
    on: ['2026-12-29', '2027-01-01', '2027-01-04'],
    off: ['2026-12-28', '2027-01-05'],
  },
  'Feb 29 single day rolls to Mar 1 in a common year': {
    f: { month: 2, day: 29 },
    on: ['2028-02-29', '2027-03-01'],
    off: ['2027-02-28', '2028-03-01'],
  },
  'range within a year, both ends included': {
    f: { month: 11, day: 1, endMonth: 11, endDay: 10, windowDays: 3 },
    on: ['2026-11-01', '2026-11-05', '2026-11-10'],
    off: ['2026-10-31', '2026-10-29', '2026-11-11', '2026-11-13'],
  },
  'range wrapping past New Year': {
    f: { month: 11, day: 28, endMonth: 1, endDay: 2 },
    on: ['2026-11-28', '2026-12-25', '2026-12-31', '2027-01-01', '2027-01-02'],
    off: ['2026-11-27', '2027-01-03', '2026-06-15'],
  },
  'range starting Feb 29 begins Mar 1 in a common year': {
    f: { month: 2, day: 29, endMonth: 3, endDay: 5 },
    on: ['2028-02-29', '2027-03-01', '2027-03-05'],
    off: ['2027-02-28', '2027-03-06'],
  },
  'range ending Feb 29 ends Feb 28 in a common year': {
    f: { month: 2, day: 20, endMonth: 2, endDay: 29 },
    on: ['2027-02-20', '2027-02-28', '2028-02-29'],
    off: ['2027-03-01', '2028-03-01', '2027-02-19'],
  },
  'start equal to end is one day': {
    f: { month: 7, day: 4, endMonth: 7, endDay: 4, windowDays: 2 },
    on: ['2026-07-04'],
    off: ['2026-07-03', '2026-07-05'],
  },
  'a one-day Feb 29 range rolls to Mar 1 in a common year, like a single day': {
    f: { month: 2, day: 29, endMonth: 2, endDay: 29, windowDays: 2 },
    on: ['2028-02-29', '2027-03-01'],
    off: ['2027-02-28', '2027-03-02', '2028-02-28', '2028-03-01'],
  },
  'half-set end reads as a single day with its window': {
    f: { month: 12, day: 25, windowDays: 1, endMonth: 1 },
    on: ['2026-12-24', '2026-12-26'],
    off: ['2026-12-27', '2027-01-01'],
  },
  'malformed end reads as a single day': {
    f: { month: 12, day: 25, endMonth: 13, endDay: 1 },
    on: ['2026-12-25'],
    off: ['2026-12-26', '2027-01-01'],
  },
  'over-long end reads as a single day': {
    f: { month: 1, day: 1, endMonth: 6, endDay: 30 },
    on: ['2026-01-01'],
    off: ['2026-01-02', '2026-03-15'],
  },
};

test('the panel badge agrees with the controller rule on every shared case', () => {
  for (const [name, c] of Object.entries(CASES)) {
    for (const d of c.on) assert.equal(festivalTiming(c.f, local(d)).active, true, `${name}: on ${d}`);
    for (const d of c.off) assert.equal(festivalTiming(c.f, local(d)).active, false, `${name}: off ${d}`);
  }
});

test('up next counts days to the start date, wrapping the year', () => {
  assert.equal(festivalTiming({ month: 11, day: 28, endMonth: 1, endDay: 2 }, local('2026-11-18')).until, 10);
  assert.equal(festivalTiming({ month: 1, day: 1 }, local('2026-12-30')).until, 2);
  assert.equal(festivalTiming({ month: 12, day: 25 }, local('2026-12-25')).until, 0);
});

test('the row label shows the range, else the window', () => {
  assert.equal(festivalSpanLabel({ month: 11, day: 28, endMonth: 1, endDay: 2, windowDays: 3 }), '28 Nov – 2 Jan');
  assert.equal(festivalSpanLabel({ month: 12, day: 25, windowDays: 1 }), '±1d');
  assert.equal(festivalSpanLabel({ month: 12, day: 25 }), null);
  assert.equal(festivalSpanLabel({ month: 12, day: 25, windowDays: 2, endMonth: 1 }), '±2d');
});
