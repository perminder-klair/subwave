import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveShowOccurrence } from '../src/broadcast/show-occurrence.js';
import type { ScheduleWeek } from '../src/schemas/schedule.js';
import { zonedParts, setStationTimezone } from '../src/time.js';
const zonedPartsFor = (date: Date, zone: string) => { setStationTimezone(zone); return zonedParts(date); };

const week = (): ScheduleWeek => Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Array(24).fill(null)]));
const iso = (s: string) => Date.parse(s);
const occurrence = (at: string, schedule: ScheduleWeek, zone = 'UTC') => resolveShowOccurrence({ at: iso(at), showId: 's_artist', schedule, override: null, parts: ms => zonedPartsFor(new Date(ms), zone) });

test('contiguous show hours survive midnight and a four-hour session roll; next airing differs', () => {
  const schedule = week(); schedule[1][22] = schedule[1][23] = schedule[2][0] = schedule[2][1] = schedule[2][2] = 's_artist';
  const first = occurrence('2026-10-05T22:02Z', schedule);
  assert.ok(first);
  assert.equal(first.id, occurrence('2026-10-06T02:10Z', schedule)?.id);
  assert.equal(first.startsAt, iso('2026-10-05T22:00Z'));
  assert.equal(first.endsAt, iso('2026-10-06T03:00Z'));
  assert.notEqual(first.id, occurrence('2026-10-12T22:02Z', schedule)?.id);
});

test('takeovers get a separate choice while returning to the same scheduled occurrence', () => {
  const schedule = week(); schedule[2].fill('s_artist');
  const before = occurrence('2026-10-06T09:00Z', schedule);
  const during = resolveShowOccurrence({ at: iso('2026-10-06T10:10Z'), showId: 's_artist', schedule,
    override: { showId: 's_artist', startedAt: iso('2026-10-06T10:00Z'), expiresAt: iso('2026-10-06T11:00Z') }, parts: ms => zonedPartsFor(new Date(ms), 'UTC') });
  assert.notEqual(before?.id, during?.id);
  assert.equal(before?.id, occurrence('2026-10-06T11:10Z', schedule)?.id);
});

test('offset zones and repeated DST hours preserve a contiguous occurrence', () => {
  const schedule = week(); schedule[0][1] = schedule[0][2] = 's_artist';
  const first = occurrence('2026-10-25T00:10Z', schedule, 'Europe/London');
  const second = occurrence('2026-10-25T01:10Z', schedule, 'Europe/London');
  assert.equal(first?.id, second?.id);
  assert.equal(first?.endsAt, iso('2026-10-25T03:00Z'));
  const offset = week(); offset[2][9] = 's_artist';
  assert.equal(occurrence('2026-10-06T03:35Z', offset, 'Asia/Kolkata')?.startsAt, iso('2026-10-06T03:30Z'));
});

test('a show pinned for the entire week rolls its preparation at Sunday midnight', () => {
  const schedule = week(); Object.values(schedule).forEach(day => day.fill('s_artist'));
  assert.equal(occurrence('2026-10-10T20:00Z', schedule)?.startsAt, iso('2026-10-04T00:00Z'));
  assert.notEqual(occurrence('2026-10-10T20:00Z', schedule)?.id, occurrence('2026-10-11T00:00Z', schedule)?.id);
});
