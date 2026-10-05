// fmtStationDateTime — the admin top-bar station clock (web/lib/format.ts).
// Pins the station-zone date, the 12h/24h split by station locale, and the
// two edges where a clock is easiest to get wrong: a date boundary that falls
// on a different day in the station's zone than in UTC, and a DST change.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Built as a string so tsc's controller project does not pull web/ in (same
// pattern as show-candidate-display.test.ts).
const formatModulePath = '../../web/lib/' + 'format.js';
const format = await import(formatModulePath);
const fmt = format.fmtStationDateTime as (
  t: string | number | Date,
  tz?: string | null,
  locale?: 'en-GB' | 'en-US' | null,
) => string;

// ICU versions differ on which space they put before AM/PM (U+0020 vs
// U+202F) and the date/time gap is NBSPs, so compare on normalised spaces.
// They also differ on the en-GB short September ("Sep" in older ICU, "Sept"
// in newer), so fold that too.
const norm = (s: string) => s.replace(/[\u00a0\u202f\s]+/g, ' ').replace(/\bSept\b/, 'Sep').trim();

test('London, en-GB: compact date with weekday and a 24-hour clock', () => {
  // 2026-09-24T03:37:45Z is 04:37:45 BST.
  assert.equal(
    norm(fmt(Date.UTC(2026, 8, 24, 3, 37, 45), 'Europe/London', 'en-GB')),
    'Thu 24 Sep · 04:37:45',
  );
});

test('New York, en-US: compact date and a 12-hour clock', () => {
  // 2026-09-24T20:05:09Z is 16:05:09 EDT.
  assert.equal(
    norm(fmt(Date.UTC(2026, 8, 24, 20, 5, 9), 'America/New_York', 'en-US')),
    'Thu 24 Sep · 4:05:09 PM',
  );
});

test('ICU weekday punctuation does not change the compact station date', (t) => {
  const DateTimeFormat = Intl.DateTimeFormat;
  t.mock.method(Intl, 'DateTimeFormat', function (
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    const formatter = new DateTimeFormat(...args);
    if (args[1]?.weekday === 'short') {
      // Reproduce ICU 74's comma even when this test runs on newer ICU.
      // Keep real zoned parts so weekday/date/time must still be correct.
      Object.defineProperty(formatter, 'format', {
        value: (date: Date | number) => {
          const parts = formatter.formatToParts(date);
          const part = (type: Intl.DateTimeFormatPartTypes) =>
            parts.find((p) => p.type === type)?.value ?? '';
          return `${part('weekday')}, ${part('day')} ${part('month')}`;
        },
      });
    }
    return formatter;
  });

  const yearEnd = Date.UTC(2026, 11, 31, 23, 30, 0);
  assert.equal(norm(fmt(yearEnd, 'UTC', 'en-GB')), 'Thu 31 Dec · 23:30:00');
  assert.equal(norm(fmt(yearEnd, 'Asia/Tokyo', 'en-GB')), 'Fri 1 Jan · 08:30:00');
  assert.equal(norm(fmt(yearEnd, 'America/New_York', 'en-US')), 'Thu 31 Dec · 6:30:00 PM');
});

test('the date follows the station zone across a day and year boundary', () => {
  const t = Date.UTC(2026, 11, 31, 23, 30, 0); // 31 Dec 23:30 UTC
  assert.equal(norm(fmt(t, 'UTC', 'en-GB')), 'Thu 31 Dec · 23:30:00');
  assert.equal(norm(fmt(t, 'Asia/Tokyo', 'en-GB')), 'Fri 1 Jan · 08:30:00');
  assert.equal(norm(fmt(t, 'America/Los_Angeles', 'en-GB')), 'Thu 31 Dec · 15:30:00');
});

test('DST: London springs forward from GMT to BST', () => {
  // 2026-03-29 01:00 UTC is the changeover: 00:59:59 GMT, then 02:00:00 BST.
  const before = Date.UTC(2026, 2, 29, 0, 59, 59);
  const after = Date.UTC(2026, 2, 29, 1, 0, 0);
  assert.equal(norm(fmt(before, 'Europe/London', 'en-GB')), 'Sun 29 Mar · 00:59:59');
  assert.equal(norm(fmt(after, 'Europe/London', 'en-GB')), 'Sun 29 Mar · 02:00:00');
});

test('DST: New York falls back and repeats the 1 AM hour', () => {
  // 2026-11-01 06:00 UTC is 01:00 EST, one hour after 01:00 EDT (05:00 UTC).
  assert.equal(
    norm(fmt(Date.UTC(2026, 10, 1, 5, 0, 0), 'America/New_York', 'en-US')),
    'Sun 1 Nov · 1:00:00 AM',
  );
  assert.equal(
    norm(fmt(Date.UTC(2026, 10, 1, 6, 0, 0), 'America/New_York', 'en-US')),
    'Sun 1 Nov · 1:00:00 AM',
  );
});

test('an unknown locale falls back to en-GB (24-hour)', () => {
  assert.equal(
    norm(fmt(Date.UTC(2026, 8, 24, 13, 0, 0), 'UTC', null)),
    'Thu 24 Sep · 13:00:00',
  );
});

test('an invalid timezone returns an empty string rather than throwing', () => {
  assert.equal(fmt(Date.UTC(2026, 8, 24, 13, 0, 0), 'Not/AZone', 'en-GB'), '');
});
