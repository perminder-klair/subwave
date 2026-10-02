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
const norm = (s: string) => s.replace(/[  \s]+/g, ' ').trim();

test('London, en-GB: full English date and a 24-hour clock', () => {
  // 2026-09-24T03:37:45Z is 04:37:45 BST.
  assert.equal(
    norm(fmt(Date.UTC(2026, 8, 24, 3, 37, 45), 'Europe/London', 'en-GB')),
    'Thursday 24 September 2026 04:37:45',
  );
});

test('New York, en-US: 12-hour clock, English date words', () => {
  // 2026-09-24T20:05:09Z is 16:05:09 EDT.
  assert.equal(
    norm(fmt(Date.UTC(2026, 8, 24, 20, 5, 9), 'America/New_York', 'en-US')),
    'Thursday 24 September 2026 4:05:09 PM',
  );
});

test('the date follows the station zone across a day and year boundary', () => {
  const t = Date.UTC(2026, 11, 31, 23, 30, 0); // 31 Dec 23:30 UTC
  assert.equal(norm(fmt(t, 'UTC', 'en-GB')), 'Thursday 31 December 2026 23:30:00');
  assert.equal(norm(fmt(t, 'Asia/Tokyo', 'en-GB')), 'Friday 1 January 2027 08:30:00');
  assert.equal(norm(fmt(t, 'America/Los_Angeles', 'en-GB')), 'Thursday 31 December 2026 15:30:00');
});

test('DST: London springs forward from GMT to BST', () => {
  // 2026-03-29 01:00 UTC is the changeover: 00:59:59 GMT, then 02:00:00 BST.
  const before = Date.UTC(2026, 2, 29, 0, 59, 59);
  const after = Date.UTC(2026, 2, 29, 1, 0, 0);
  assert.equal(norm(fmt(before, 'Europe/London', 'en-GB')), 'Sunday 29 March 2026 00:59:59');
  assert.equal(norm(fmt(after, 'Europe/London', 'en-GB')), 'Sunday 29 March 2026 02:00:00');
});

test('DST: New York falls back and repeats the 1 AM hour', () => {
  // 2026-11-01 06:00 UTC is 01:00 EST, one hour after 01:00 EDT (05:00 UTC).
  assert.equal(
    norm(fmt(Date.UTC(2026, 10, 1, 5, 0, 0), 'America/New_York', 'en-US')),
    'Sunday 1 November 2026 1:00:00 AM',
  );
  assert.equal(
    norm(fmt(Date.UTC(2026, 10, 1, 6, 0, 0), 'America/New_York', 'en-US')),
    'Sunday 1 November 2026 1:00:00 AM',
  );
});

test('an unknown locale falls back to en-GB (24-hour)', () => {
  assert.equal(
    norm(fmt(Date.UTC(2026, 8, 24, 13, 0, 0), 'UTC', null)),
    'Thursday 24 September 2026 13:00:00',
  );
});

test('an invalid timezone returns an empty string rather than throwing', () => {
  assert.equal(fmt(Date.UTC(2026, 8, 24, 13, 0, 0), 'Not/AZone', 'en-GB'), '');
});
