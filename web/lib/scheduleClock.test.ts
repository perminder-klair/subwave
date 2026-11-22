// The schedule drawer's local-time labels: a station hour becomes the instant
// it next falls on, shown in the listener's zone, with the day when it moves.
//
// Run: `npm test -- lib/scheduleClock`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayOffsetFor, shownHour, stationHourInstant } from './scheduleClock';

// Sunday 22 Nov 2026, 14:34 in London = 20:04 in India (+5:30).
const NOW = new Date('2026-11-22T14:34:20Z');
const IN = 'Asia/Calcutta';
const UK = 'Europe/London';
const SUN = 0;

test('a station hour today lands on its instant', () => {
  assert.equal(stationHourInstant(NOW, IN, 0, 22).toISOString(), '2026-11-22T16:30:00.000Z');
  assert.equal(stationHourInstant(NOW, IN, 0, 20).toISOString(), '2026-11-22T14:30:00.000Z');
});

test('hour 24 is the next station midnight', () => {
  assert.equal(stationHourInstant(NOW, IN, 0, 24).toISOString(), '2026-11-22T18:30:00.000Z');
});

test('a later station day adds whole days', () => {
  assert.equal(stationHourInstant(NOW, IN, 2, 9).toISOString(), '2026-11-24T03:30:00.000Z');
});

test('dayOffsetFor wraps to the next time the day comes round', () => {
  assert.equal(dayOffsetFor(0, 0), 0);
  assert.equal(dayOffsetFor(2, 0), 2);
  assert.equal(dayOffsetFor(0, 6), 1);
  assert.equal(dayOffsetFor(5, 6), 6);
});

test('the London listener reads the half-hour offset', () => {
  assert.equal(shownHour(NOW, IN, UK, SUN, SUN, 22, 'en-US'), '04:30 PM');
  assert.equal(shownHour(NOW, IN, UK, SUN, SUN, 22, 'en-GB'), '16:30');
});

test('a slot that lands on another day there names that day', () => {
  // 02:00 Monday in India is 20:30 Sunday in London.
  assert.equal(shownHour(NOW, IN, UK, 1, SUN, 2, 'en-GB'), 'SUN 20:30');
});

test('an end is dated by its last minute', () => {
  // Sunday's 22:00–00:00 block ends at 18:30 Sunday in London: no day tag.
  assert.equal(shownHour(NOW, IN, UK, SUN, SUN, 24, 'en-GB', 'end'), '18:30');
  // In the station's own zone that end is midnight, still Sunday's block.
  assert.equal(shownHour(NOW, IN, IN, SUN, SUN, 24, 'en-GB', 'end'), '00:00');
});

test('the same zone reads the station hour back', () => {
  assert.equal(shownHour(NOW, IN, IN, SUN, SUN, 22, 'en-GB'), '22:00');
});

test('a station DST change between now and the slot still lands on the hour', () => {
  // London springs forward on 29 Mar 2026; from the Saturday, 09:00 on the
  // Sunday after is 08:00Z, not 09:00Z.
  const sat = new Date('2026-03-28T12:00:00Z');
  assert.equal(stationHourInstant(sat, UK, 1, 9).toISOString(), '2026-03-29T08:00:00.000Z');
});
