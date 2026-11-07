// time.ts's timezone-change subscription, which the per-skill cron tasks use
// to re-register. node-cron bakes the zone in at registration, so the
// notification sits at the one place the zone changes rather than at each
// writer (POST /settings, onboarding, a backup restore).
//
// The no-change guard is the other half: load() and every update() push the
// zone in whether or not it moved. It compares the EFFECTIVE zone, so naming
// the zone the process already runs in is not a change either (#2254).

import assert from 'node:assert/strict';
import test from 'node:test';

import { setStationTimezone, getStationTimezone, onStationTimezoneChange } from '../src/time.js';

// Auto resolves to the process zone; pin it so "Auto" and "Asia/Kolkata" differ.
process.env.TZ = 'UTC';

const seen: string[] = [];
onStationTimezoneChange((tz) => seen.push(tz));

test('a real change notifies subscribers with the effective zone', () => {
  seen.length = 0;
  setStationTimezone('Europe/London');
  assert.deepEqual(seen, ['Europe/London']);
  assert.equal(getStationTimezone(), 'Europe/London');

  setStationTimezone('Asia/Kolkata');
  assert.deepEqual(seen, ['Europe/London', 'Asia/Kolkata']);
});

test('re-setting the same zone notifies nobody', () => {
  setStationTimezone('Asia/Kolkata');
  seen.length = 0;
  setStationTimezone('Asia/Kolkata');
  assert.deepEqual(seen, []);
});

test('an invalid zone resolves to Auto and notifies once, not per bad value', () => {
  setStationTimezone('Asia/Kolkata');
  seen.length = 0;
  setStationTimezone('Not/AZone');
  assert.equal(seen.length, 1, 'falling back to Auto is a real change');
  // Auto is whatever the process resolved to, never the literal bad string.
  assert.notEqual(seen[0], 'Not/AZone');
  assert.equal(seen[0], getStationTimezone());

  setStationTimezone('Also/Bogus');
  assert.equal(seen.length, 1, 'still Auto — not a change, so no second notify');
});

test('a throwing subscriber does not block the others or the write', () => {
  // One bad subscriber must not leave the zone half-applied.
  const after: string[] = [];
  onStationTimezoneChange(() => { throw new Error('boom'); });
  onStationTimezoneChange((tz) => after.push(tz));

  setStationTimezone('America/New_York');
  assert.equal(getStationTimezone(), 'America/New_York');
  assert.deepEqual(after, ['America/New_York']);
});

test("naming the process's own zone, or going back to Auto from it, notifies nobody", () => {
  setStationTimezone('');
  assert.equal(getStationTimezone(), 'UTC');
  seen.length = 0;
  setStationTimezone('UTC');
  assert.equal(getStationTimezone(), 'UTC');
  setStationTimezone('');
  assert.deepEqual(seen, [], 'Auto and the host zone are the same clock');

  setStationTimezone('Europe/London');
  assert.deepEqual(seen, ['Europe/London']);
});
