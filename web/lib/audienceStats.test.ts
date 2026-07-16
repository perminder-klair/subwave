// Unit tests for the pure Audience-stats derivations. Same lightweight harness
// as controller/scripts/*.test.ts (assert + ✓/✗ + non-zero exit on failure).
// Run from the repo root:  npx tsx web/lib/audienceStats.test.ts
//
// bucketSamplesByHour uses local time (Date#getHours), so the hour-bucket tests
// build timestamps from local Date components rather than hard-coded UTC ISO
// strings — that keeps them correct regardless of the machine's timezone.

import assert from 'node:assert/strict';
import {
  bucketSamplesByHour,
  groupConnectionsByDevice,
  type DeviceGroup,
  type HourBucket,
} from './audienceStats';
import type { ListenerConnection } from './clientLabel';

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

// Narrow away the `T | undefined` that strict indexed access yields, throwing a
// legible test failure rather than leaning on non-null assertions.
function req<T>(v: T | undefined, msg: string): T {
  if (v === undefined) throw new Error(`missing ${msg}`);
  return v;
}
const hour = (buckets: HourBucket[], h: number) => req(buckets[h], `hour ${h}`);
const group = (groups: DeviceGroup[], i: number) => req(groups[i], `group ${i}`);

// Build an ISO timestamp for a given local hour/minute on a fixed local day.
function at(h: number, minute = 0): string {
  return new Date(2026, 0, 5, h, minute, 0, 0).toISOString();
}

function conn(userAgent: string, connectedSeconds: number): ListenerConnection {
  return { ip: '', mount: '/stream.mp3', userAgent, connectedSeconds };
}

console.log('bucketSamplesByHour:');

test('returns all 24 hours in order, even with no samples', () => {
  const b = bucketSamplesByHour([]);
  assert.equal(b.length, 24);
  assert.deepEqual(
    b.map(x => x.hour),
    Array.from({ length: 24 }, (_, i) => i),
  );
  assert.ok(b.every(x => x.avg === 0 && x.peak === 0 && x.samples === 0));
});

test('averages counts within the same local hour', () => {
  const b = bucketSamplesByHour([
    { t: at(9, 0), count: 2 },
    { t: at(9, 30), count: 4 },
    { t: at(9, 59), count: 6 },
  ]);
  const nine = hour(b, 9);
  assert.equal(nine.samples, 3);
  assert.equal(nine.avg, 4); // (2+4+6)/3
  assert.equal(nine.peak, 6);
});

test('separates samples into their own hour buckets', () => {
  const b = bucketSamplesByHour([
    { t: at(0, 10), count: 1 },
    { t: at(23, 10), count: 9 },
  ]);
  assert.equal(hour(b, 0).samples, 1);
  assert.equal(hour(b, 0).avg, 1);
  assert.equal(hour(b, 23).samples, 1);
  assert.equal(hour(b, 23).peak, 9);
  assert.equal(hour(b, 12).samples, 0); // untouched hour stays empty
});

test('skips unparseable timestamps without throwing', () => {
  const b = bucketSamplesByHour([
    { t: 'not-a-date', count: 5 },
    { t: at(6, 0), count: 3 },
  ]);
  assert.equal(hour(b, 6).samples, 1);
  assert.equal(hour(b, 6).avg, 3);
});

test('treats a non-finite count as zero', () => {
  const b = bucketSamplesByHour([
    { t: at(6, 0), count: Number.NaN },
    { t: at(6, 30), count: 4 },
  ]);
  assert.equal(hour(b, 6).samples, 2);
  assert.equal(hour(b, 6).avg, 2); // (0 + 4) / 2
});

console.log('groupConnectionsByDevice:');

test('empty input yields an empty breakdown', () => {
  assert.deepEqual(groupConnectionsByDevice([]), []);
});

test('groups by device class with avg + max connected-for', () => {
  const groups = groupConnectionsByDevice([
    conn('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari', 60),
    conn('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari', 180),
    conn('Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome', 300),
  ]);
  assert.equal(groups.length, 2);
  // iPhone has 2 listeners → sorts first (count desc).
  const iphone = group(groups, 0);
  assert.equal(iphone.device, 'iPhone');
  assert.equal(iphone.count, 2);
  assert.equal(iphone.avgSeconds, 120); // (60+180)/2
  assert.equal(iphone.maxSeconds, 180);
  const mac = group(groups, 1);
  assert.equal(mac.device, 'Mac');
  assert.equal(mac.count, 1);
  assert.equal(mac.avgSeconds, 300);
});

test('classifies dedicated players ahead of browser families', () => {
  const groups = groupConnectionsByDevice([conn('Linux UPnP/1.0 Sonos/1.0', 90)]);
  assert.equal(group(groups, 0).device, 'Sonos');
});

test('collapses unrecognised user-agents to Other', () => {
  const groups = groupConnectionsByDevice([conn('SomeObscureRadio/2.1', 45)]);
  assert.equal(group(groups, 0).device, 'Other');
});

test('clamps a negative connected-for to zero in the average', () => {
  const groups = groupConnectionsByDevice([
    conn('Mozilla/5.0 (Windows NT 10.0) Chrome', -5),
    conn('Mozilla/5.0 (Windows NT 10.0) Chrome', 100),
  ]);
  const win = group(groups, 0);
  assert.equal(win.device, 'Windows');
  assert.equal(win.avgSeconds, 50); // (0 + 100) / 2
  assert.equal(win.maxSeconds, 100);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll audienceStats tests passed.');
