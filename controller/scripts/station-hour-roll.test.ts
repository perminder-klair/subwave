// The talk tick's top-of-hour session roll runs on the STATION clock (#2234).
// The show grid changes at station :00. A roll on process :00 landed 30 or 45
// minutes into the new show whenever the station zone sat a fractional number
// of hours from the container's (IST or Nepal on a UTC or London host, or a
// London station on an IST host), leaving the previous show's session and coast
// playlist on air, a clean show's explicit tracks included.
//
// Drives the two helpers talkTick uses under a pinned process TZ, pairs them
// with the real hourly talk row, and checks talkTick is wired to them.
// Run: npm test -- station-hour-roll

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isStationHourStart, setStationTimezone, stationHourKey, zonedParts } from '../src/time.js';
import { openMinuteFor, talkMinute, talkSlot } from '../src/broadcast/talk-scheduler.js';

const MIN = 60_000;
const utc = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));
const at = (t: Date) => t.toISOString().slice(0, 16);
const plus = (t: Date, minutes: number) => new Date(t.getTime() + minutes * MIN);

// The process runs on `processTz` and the station on `stationTz` ('' = unset)
// for the length of `fn`; both are put back after.
function onClocks(processTz: string, stationTz: string, fn: () => void) {
  const prev = process.env.TZ;
  process.env.TZ = processTz;
  setStationTimezone(stationTz);
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
    setStationTimezone('');
  }
}

// Every minute of [from, from + minutes) the tick rolls on.
function rollsFrom(from: Date, minutes: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < minutes; i++) {
    const t = plus(from, i);
    if (isStationHourStart(t)) out.push(at(t));
  }
  return out;
}

// A show change at station 10:00 on 2026-11-02, as a UTC instant. London is
// back on GMT and St John's on NST by then.
const TEN_OCLOCK: Record<string, Date> = {
  'Europe/London': utc(2026, 11, 2, 10, 0),       // +0:00, the whole-hour control
  'Asia/Kolkata': utc(2026, 11, 2, 4, 30),        // +5:30
  'Asia/Kathmandu': utc(2026, 11, 2, 4, 15),      // +5:45
  'America/St_Johns': utc(2026, 11, 2, 13, 30),   // -3:30
};

test('a station rolls at its own 10:00 on a UTC host, whole-hour zone or not', () => {
  for (const [zone, change] of Object.entries(TEN_OCLOCK)) {
    onClocks('UTC', zone, () => {
      assert.deepEqual(
        rollsFrom(plus(change, -90), 180),
        [at(plus(change, -60)), at(change), at(plus(change, 60))],
        `${zone}: one roll per station hour, on the station's :00`,
      );
      assert.equal(stationHourKey(plus(change, -1)), '2026-11-2-9', `${zone}: 09:59 is still the 9 o'clock hour`);
      assert.equal(stationHourKey(change), '2026-11-2-10', `${zone}: the roll opens the 10 o'clock hour`);
      assert.equal(stationHourKey(plus(change, 59)), '2026-11-2-10', `${zone}: 10:59 is still the 10 o'clock hour`);
    });
  }
});

test('a Kolkata host rolls a London station at London 10:00, not at 10:30', () => {
  const change = TEN_OCLOCK['Europe/London'];  // 15:30 on the host's clock
  onClocks('Asia/Kolkata', 'Europe/London', () => {
    assert.deepEqual(
      rollsFrom(plus(change, -90), 180),
      [at(plus(change, -60)), at(change), at(plus(change, 60))],
    );
    assert.equal(isStationHourStart(plus(change, 30)), false, "the host's 16:00 is London 10:30");
    assert.equal(stationHourKey(change), '2026-11-2-10');
  });
});

// London's clock changes at 01:00 UTC on both days. Spring forward skips 01:00
// local; fall back runs the 1 o'clock hour twice, and both of them roll.
const LONDON_CHANGES = [
  {
    day: 'spring forward, 2026-03-29',
    from: utc(2026, 3, 28, 23, 0),
    rolls: [utc(2026, 3, 28, 23), utc(2026, 3, 29, 0), utc(2026, 3, 29, 1), utc(2026, 3, 29, 2)],
    hours: ['2026-3-28-23', '2026-3-29-0', '2026-3-29-2', '2026-3-29-3'],
  },
  {
    day: 'fall back, 2026-10-25',
    from: utc(2026, 10, 24, 23, 0),
    rolls: [utc(2026, 10, 24, 23), utc(2026, 10, 25, 0), utc(2026, 10, 25, 1), utc(2026, 10, 25, 2)],
    hours: ['2026-10-25-0', '2026-10-25-1', '2026-10-25-1', '2026-10-25-2'],
  },
];

test("London's clock changes keep one roll per station hour, on a UTC or a Kolkata host", () => {
  for (const host of ['UTC', 'Asia/Kolkata']) {
    for (const change of LONDON_CHANGES) {
      onClocks(host, 'Europe/London', () => {
        const label = `${change.day} on a ${host} host`;
        assert.deepEqual(rollsFrom(change.from, 240), change.rolls.map(at), `${label}: rolls`);
        assert.deepEqual(change.rolls.map(t => stationHourKey(t)), change.hours, `${label}: station hours`);
      });
    }
  }
});

// talkTick's own two lines: roll at the station's :00 and remember it by
// station hour, then hand the hourly row the roll made in this station hour.
// The row's ten-minute window is on station minutes too (#2254); what it
// must see is the roll that opened its station hour, since that roll's
// `showStarted` is what earns the hourly welcome and its `introAired` is what
// stands the check down.
function hourlyRowSees(from: Date, minutes: number) {
  const hourly = talkSlot('hourly');
  let lastRoll: { hourKey: string; at: Date } | null = null;
  const seen: { tick: string; rolled: string | null }[] = [];
  for (let i = 0; i < minutes; i++) {
    const now = plus(from, i);
    if (isStationHourStart(now)) lastRoll = { hourKey: stationHourKey(now), at: now };
    const rolled = lastRoll?.hourKey === stationHourKey(now) ? lastRoll : null;
    if (openMinuteFor(hourly, talkMinute(now)) != null) {
      seen.push({ tick: at(now), rolled: rolled ? at(rolled.at) : null });
    }
  }
  return seen;
}

test('the hourly row still finds the roll that opened its station hour', () => {
  const cases: { host: string; zone: string; from: Date; minutes: number }[] = [
    ...Object.entries(TEN_OCLOCK).map(([zone, change]) => ({ host: 'UTC', zone, from: plus(change, -60), minutes: 180 })),
    { host: 'Asia/Kolkata', zone: 'Europe/London', from: plus(TEN_OCLOCK['Europe/London'], -60), minutes: 180 },
    ...LONDON_CHANGES.flatMap(c => ['UTC', 'Asia/Kolkata'].map(host => ({ host, zone: 'Europe/London', from: c.from, minutes: 240 }))),
  ];
  for (const c of cases) {
    onClocks(c.host, c.zone, () => {
      const seen = hourlyRowSees(c.from, c.minutes);
      assert.ok(seen.length >= 20, `${c.zone} on ${c.host}: the walk spans at least two hourly windows`);
      for (const { tick, rolled } of seen) {
        assert.ok(rolled, `${c.zone} on ${c.host}: the hourly row at ${tick} found no roll`);
        const roll = new Date(`${rolled}Z`);
        const now = new Date(`${tick}Z`);
        assert.equal(zonedParts(roll).minute, 0, `${c.zone} on ${c.host}: the ${tick} check paired with a roll off the station's :00 (${rolled})`);
        assert.ok(now.getTime() - roll.getTime() < 60 * MIN, `${c.zone} on ${c.host}: the ${tick} check paired with a stale roll (${rolled})`);
      }
    });
  }
  // The show change itself: the check in the 10 o'clock hour sees the 10:00 roll.
  onClocks('UTC', 'Asia/Kolkata', () => {
    const change = TEN_OCLOCK['Asia/Kolkata'];
    const tenOclock = hourlyRowSees(plus(change, -60), 180).filter(s => stationHourKey(new Date(`${s.tick}Z`)) === '2026-11-2-10');
    assert.ok(tenOclock.length > 0);
    for (const s of tenOclock) assert.equal(s.rolled, at(change), `the ${s.tick} check sees the show-change roll`);
  });
});

test('an unset station timezone keeps the process clock exactly', () => {
  // Develop's own expressions, kept here as the reference.
  const processHourKey = (now: Date) =>
    `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}`;
  const windows = [
    utc(2026, 3, 28, 21),   // London spring forward
    utc(2026, 10, 24, 21),  // London fall back
    utc(2026, 10, 31, 23),  // St John's fall back (02:00 NDT on Nov 1)
    utc(2026, 11, 2, 0),    // an ordinary day
  ];
  for (const host of ['UTC', 'Europe/London', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/St_Johns']) {
    onClocks(host, '', () => {
      for (const from of windows) {
        for (let i = 0; i < 6 * 60; i++) {
          const now = plus(from, i);
          assert.equal(isStationHourStart(now), now.getMinutes() === 0, `${host} at ${at(now)}`);
          assert.equal(stationHourKey(now), processHourKey(now), `${host} at ${at(now)}`);
        }
      }
    });
  }
});

test('talkTick rolls and pairs on the station clock', () => {
  const scheduler = readFileSync(new URL('../src/broadcast/scheduler.ts', import.meta.url), 'utf8');
  const start = scheduler.indexOf('async function talkTick');
  assert.ok(start >= 0, 'talkTick moved');
  const tick = scheduler.slice(start, scheduler.indexOf('\n}\n', start));
  assert.match(tick, /if \(isStationHourStart\(now\)\) \{/, 'the roll fires on the station\'s :00');
  assert.match(tick, /lastRoll = roll \? \{ hourKey: stationHourKey\(now\), roll \} : null;/, 'the roll is remembered by station hour');
  assert.match(tick, /lastRoll\?\.hourKey === stationHourKey\(now\)/, 'the hourly row looks it up by station hour');
  assert.doesNotMatch(tick, /now\.get(Minutes|Hours|Date|Month|FullYear)\(\)/, 'no process-clock read decides the roll');
  assert.doesNotMatch(scheduler, /const hourKey =/, 'the process-clock hourKey is gone');
});
