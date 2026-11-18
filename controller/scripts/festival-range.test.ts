// Festival start/stop dates (#2112). A festival may carry an end date
// (endMonth + endDay, both or neither): it is then on from month/day through
// the end inclusive, wrapping past New Year, and windowDays does not apply.
// festivalActiveOn (schemas/settings.ts) is the one rule: getFestivalContext
// runs it on the station's date and the admin Festivals panel runs it for its
// "now" badge (web/lib/festivalTiming.ts, tested against the same cases).
// Run: `npm test -- festival-range`

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  festivalActiveOn,
  festivalEnd,
  festivalRangeDays,
  festivalsSchema,
  SETTINGS_FESTIVAL_RANGE_DAYS_MAX,
} from '../src/schemas/settings.js';
import { coldLoadSettings } from './test-utils/settings.js';
import { setStationTimezone } from '../src/time.js';
import { getFestivalContext } from '../src/context.js';

type Case = {
  f: { month: number; day: number; windowDays?: number; endMonth?: unknown; endDay?: unknown };
  on: string[];
  off: string[];
};

const parts = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
};

const CASES: Record<string, Case> = {
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
    // windowDays does not stretch a range
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

test('festivalActiveOn: every case in the shared table', () => {
  for (const [name, c] of Object.entries(CASES)) {
    for (const d of c.on) assert.equal(festivalActiveOn(c.f, parts(d)), true, `${name}: on ${d}`);
    for (const d of c.off) assert.equal(festivalActiveOn(c.f, parts(d)), false, `${name}: off ${d}`);
  }
});

test('festivalRangeDays counts both ends and wraps, on a 366-day calendar', () => {
  assert.equal(festivalRangeDays(12, 25, 12, 25), 1);
  assert.equal(festivalRangeDays(11, 28, 1, 2), 36);
  assert.equal(festivalRangeDays(12, 31, 1, 1), 2);
  assert.equal(festivalRangeDays(2, 1, 3, 1), 30); // Feb 29 counted
  assert.equal(festivalRangeDays(1, 1, 3, 1), SETTINGS_FESTIVAL_RANGE_DAYS_MAX + 1);
  assert.equal(festivalRangeDays(1, 1, 2, 29), SETTINGS_FESTIVAL_RANGE_DAYS_MAX);
});

test('festivalEnd: both or neither, valid, within the cap', () => {
  assert.deepEqual(festivalEnd({ month: 11, day: 28, endMonth: 1, endDay: 2 }), { month: 1, day: 2 });
  assert.equal(festivalEnd({ month: 11, day: 28 }), null);
  assert.equal(festivalEnd({ month: 11, day: 28, endMonth: 1 }), null);
  assert.equal(festivalEnd({ month: 11, day: 28, endDay: 2 }), null);
  assert.equal(festivalEnd({ month: 11, day: 28, endMonth: 1, endDay: null }), null);
  assert.equal(festivalEnd({ month: 11, day: 28, endMonth: 2, endDay: 30 }), null);
  assert.equal(festivalEnd({ month: 11, day: 28, endMonth: 'x', endDay: 2 }), null);
  assert.equal(festivalEnd({ month: 1, day: 1, endMonth: 3, endDay: 1 }), null);
});

test('festivalsSchema accepts an end date and refuses a half-set, bad or over-long one', () => {
  const strict = festivalsSchema({ moodNames: ['chill'] });
  const base = { name: 'Xmas', month: 11, day: 28, mood: 'chill' };

  const ranged = strict.parse([{ ...base, endMonth: 1, endDay: 2 }])[0]!;
  assert.equal(ranged.endMonth, 1);
  assert.equal(ranged.endDay, 2);

  // A single-day festival saves exactly the keys it always has.
  const single = strict.parse([{ ...base, endMonth: null, endDay: undefined }])[0]!;
  assert.deepEqual(Object.keys(single).sort(), [
    'day', 'description', 'month', 'mood', 'name', 'windowDays',
  ]);

  const msg = (f: object) => strict.safeParse([f]).error?.issues[0];
  assert.equal(msg({ ...base, endMonth: 1 })?.message, 'festivals[0] needs both endMonth and endDay, or neither');
  assert.deepEqual(msg({ ...base, endMonth: 1 })?.path, [0, 'endDay']);
  assert.deepEqual(msg({ ...base, endDay: 2 })?.path, [0, 'endMonth']);
  assert.equal(msg({ ...base, endMonth: 13, endDay: 1 })?.message, 'festivals[0].endMonth must be an integer 1-12');
  assert.equal(msg({ ...base, endMonth: 2, endDay: 30 })?.message, 'festivals[0].endDay must be an integer 1-29 for month 2');
  assert.equal(
    msg({ ...base, month: 1, day: 1, endMonth: 3, endDay: 1 })?.message,
    `festivals[0] may run at most ${SETTINGS_FESTIVAL_RANGE_DAYS_MAX} days, start and end included`,
  );
  // Exactly the cap is fine, wrapping or not.
  assert.equal(strict.safeParse([{ ...base, month: 1, day: 1, endMonth: 2, endDay: 29 }]).success, true);
  assert.equal(strict.safeParse([{ ...base, month: 12, day: 1, endMonth: 1, endDay: 29 }]).success, true);
  assert.equal(strict.safeParse([{ ...base, month: 12, day: 1, endMonth: 1, endDay: 30 }]).success, false);
});

test('getFestivalContext runs the rule on the station date, first match wins', async () => {
  await coldLoadSettings({
    festivals: [
      { name: 'Family Christmas', month: 11, day: 28, endMonth: 1, endDay: 2, mood: 'celebratory' },
      { name: 'Christmas', month: 12, day: 25, windowDays: 1, mood: 'reflective' },
      // Hand-edited half-set end: today's single-day behaviour.
      { name: 'Half', month: 6, day: 10, endMonth: 7, mood: 'calm' },
    ],
  });
  setStationTimezone('UTC');
  try {
    assert.equal(getFestivalContext(new Date('2026-12-30T12:00:00Z'))?.name, 'Family Christmas');
    // Overlap: the first festival in list order wins, as before.
    assert.equal(getFestivalContext(new Date('2026-12-25T12:00:00Z'))?.name, 'Family Christmas');
    assert.equal(getFestivalContext(new Date('2027-01-03T12:00:00Z')), null);
    assert.equal(getFestivalContext(new Date('2026-06-10T12:00:00Z'))?.name, 'Half');
    assert.equal(getFestivalContext(new Date('2026-06-11T12:00:00Z')), null);
    // The station's zone decides the date: 23:30 UTC on Jan 2 is Jan 3 in Tokyo.
    assert.equal(getFestivalContext(new Date('2027-01-02T23:30:00Z'))?.name, 'Family Christmas');
    setStationTimezone('Asia/Tokyo');
    assert.equal(getFestivalContext(new Date('2027-01-02T23:30:00Z')), null);
  } finally {
    setStationTimezone('');
  }
});

