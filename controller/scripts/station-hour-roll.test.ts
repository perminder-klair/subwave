// The talk tick's session roll runs on the STATION clock (#2234), and rolls
// when the station's position moved since the last tick: its station hour or
// its active show (#2254). The show grid changes at the station hour. A roll on
// process :00 landed 30 or 45 minutes into the new show whenever the station
// zone sat a fractional number of hours from the container's, and a roll on
// station minute 0 missed every hour that opens without a :00 reaching a tick:
// a timezone saved mid-hour, and the 30- and 45-minute DST shifts of Lord Howe
// and Chatham. A schedule edit that changes the show on air rolls on the next
// tick too.
//
// Drives the decision talkTick makes (session-roll-policy.ts) over the real
// station-hour key and show resolver under a pinned process TZ, pairs it with
// the real hourly talk row, and checks talkTick is wired to it.
// Run: npm test -- station-hour-roll

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setStationTimezone, stationHourKey, stationHourStartProcessMinute, stationUtcOffsetMinutes, zonedParts } from '../src/time.js';
import { sessionRollDue, stationPosition, type StationPosition } from '../src/broadcast/session-roll-policy.js';
import { resolveActiveShow } from '../src/settings/persona.js';
import { openMinuteFor, talkSlot } from '../src/broadcast/talk-scheduler.js';

const MIN = 60_000;
const utc = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s));
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

type Settings = Parameters<typeof resolveActiveShow>[1];
// An empty grid: only the station hour moves the position.
const NO_SHOWS = { shows: [], schedule: {}, personas: [] } as unknown as Settings;

// The scheduler's position at `t`, from the real key and the real resolver.
const positionAt = (t: Date, s: Settings = NO_SHOWS): StationPosition =>
  stationPosition(stationHourKey(t), stationUtcOffsetMinutes(t), resolveActiveShow(t, s));

// talkTick's roll, minute by minute. The baseline is seeded at `boot` (by
// startScheduler), the ticks run on each whole minute of [from, from + minutes).
// `before(t)` runs ahead of the tick at t, for a save that lands mid-hour.
function rollsFrom(
  from: Date,
  minutes: number,
  { boot = new Date(from.getTime() - 30_000), settings = () => NO_SHOWS, before }:
    { boot?: Date; settings?: () => Settings; before?: (t: Date) => void } = {},
): string[] {
  let last: StationPosition | null = positionAt(boot, settings());
  const out: string[] = [];
  for (let i = 0; i < minutes; i++) {
    const t = plus(from, i);
    before?.(t);
    const now = positionAt(t, settings());
    if (sessionRollDue(last, now)) {
      out.push(at(t));
      last = now;
    }
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
    assert.equal(stationHourStartProcessMinute(change), 30, "London's :00 is the host's :30");
    assert.equal(stationHourKey(change), '2026-11-2-10');
  });
});

test('the baseline is the boot, not the first tick', () => {
  onClocks('UTC', 'Asia/Kolkata', () => {
    const change = TEN_OCLOCK['Asia/Kolkata'];
    // Booted at 09:59:30, first tick at 10:00: the 10:00 roll still happens.
    assert.deepEqual(rollsFrom(change, 5, { boot: new Date(change.getTime() - 30_000) }), [at(change)]);
    // Booted at 10:20: no roll for the hour it found, the next one at 11:00.
    const boot = plus(change, 20);
    assert.deepEqual(rollsFrom(plus(boot, 1), 60, { boot }), [at(plus(change, 60))]);
  });
  // Before the scheduler starts there is no baseline, and nothing rolls.
  assert.equal(sessionRollDue(null, { hourKey: 'x', utcOffset: 0, showId: null }), false);
});

// London's clock changes at 01:00 UTC on both days. Spring forward skips 01:00
// local; fall back runs the 1 o'clock hour twice. The repeat has the same key
// but a new UTC offset, so it rolls again: a no-op roll that gives its hourly
// row a roll of its own, so the first pass's show welcome is not re-aired.
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
  // The repeated hour really does repeat its key; the offset tells them apart.
  onClocks('UTC', 'Europe/London', () => {
    assert.equal(stationHourKey(utc(2026, 10, 25, 1, 0)), stationHourKey(utc(2026, 10, 25, 0, 0)));
    assert.equal(stationUtcOffsetMinutes(utc(2026, 10, 25, 0, 0)), 60);
    assert.equal(stationUtcOffsetMinutes(utc(2026, 10, 25, 1, 0)), 0);
  });
});

// Zones whose DST shift is 30 or 45 minutes have transition hours with no
// station :00. Each one still rolls, at its first minute (#2254).
const FRACTIONAL_DST = [
  {
    // 02:00 LHST -> 02:30 LHDT: hour 2 opens at 02:30.
    zone: 'Australia/Lord_Howe', day: 'spring forward, 2026-10-04',
    from: utc(2026, 10, 3, 14, 0), minutes: 180,
    rolls: [utc(2026, 10, 3, 14, 30), utc(2026, 10, 3, 15, 30), utc(2026, 10, 3, 16, 0)],
    hours: ['2026-10-4-1', '2026-10-4-2', '2026-10-4-3'],
  },
  {
    // 02:00 LHDT -> 01:30 LHST: 01:30-01:59 repeats inside the same grid
    // hour, under a new offset, so it rolls again (a no-op).
    zone: 'Australia/Lord_Howe', day: 'fall back, 2026-04-05',
    from: utc(2026, 4, 4, 14, 0), minutes: 180,
    rolls: [utc(2026, 4, 4, 14, 0), utc(2026, 4, 4, 15, 0), utc(2026, 4, 4, 15, 30), utc(2026, 4, 4, 16, 30)],
    hours: ['2026-4-5-1', '2026-4-5-1', '2026-4-5-2', '2026-4-5-3'],
  },
  {
    // 02:45 CHAST -> 03:45 CHADT: hour 3 opens at 03:45.
    zone: 'Pacific/Chatham', day: 'spring forward, 2026-09-27',
    from: utc(2026, 9, 26, 13, 0), minutes: 120,
    rolls: [utc(2026, 9, 26, 13, 15), utc(2026, 9, 26, 14, 0), utc(2026, 9, 26, 14, 15)],
    hours: ['2026-9-27-2', '2026-9-27-3', '2026-9-27-4'],
  },
  {
    // 03:45 CHADT -> 02:45 CHAST: 02:45-02:59 comes back after hour 3.
    zone: 'Pacific/Chatham', day: 'fall back, 2026-04-05',
    from: utc(2026, 4, 4, 12, 0), minutes: 180,
    rolls: [utc(2026, 4, 4, 12, 15), utc(2026, 4, 4, 13, 15), utc(2026, 4, 4, 14, 0), utc(2026, 4, 4, 14, 15)],
    hours: ['2026-4-5-2', '2026-4-5-3', '2026-4-5-2', '2026-4-5-3'],
  },
];

test('Lord Howe and Chatham roll every transition hour, on any host', () => {
  for (const host of ['UTC', 'Europe/London', 'Asia/Kolkata']) {
    for (const c of FRACTIONAL_DST) {
      onClocks(host, c.zone, () => {
        const label = `${c.zone} ${c.day} on a ${host} host`;
        assert.deepEqual(rollsFrom(c.from, c.minutes), c.rolls.map(at), `${label}: rolls`);
        assert.deepEqual(c.rolls.map(t => stationHourKey(t)), c.hours, `${label}: station hours`);
      });
    }
  }
});

test('a whole year in Lord Howe and Chatham rolls once per station hour, and once more per repeat', () => {
  for (const zone of ['Australia/Lord_Howe', 'Pacific/Chatham']) {
    onClocks('UTC', zone, () => {
      const from = utc(2026, 1, 1, 0, 0);
      let last: StationPosition | null = positionAt(new Date(from.getTime() - 30_000));
      let prev = `${last.hourKey}@${last.utcOffset}`;
      let visits = 0;
      let rolls = 0;
      const offsetsSeen = new Set<number>();
      for (let ms = from.getTime(); ms < utc(2027, 1, 1, 0, 0).getTime(); ms += MIN) {
        const t = new Date(ms);
        const now = positionAt(t);
        offsetsSeen.add(now.utcOffset);
        const here = `${now.hourKey}@${now.utcOffset}`;
        if (here !== prev) { visits++; prev = here; }
        if (sessionRollDue(last, now)) { rolls++; last = now; }
      }
      assert.ok(visits > 8700, `${zone}: the walk covers the year`);
      assert.equal(offsetsSeen.size, 2, `${zone}: the year has its standard and its daylight offset`);
      assert.equal(rolls, visits, `${zone}: every station hour the tick enters rolls, and nothing else does`);
    });
  }
});

test('a timezone saved mid-hour rolls on the next tick, not at the next :00', () => {
  // The verifier's case: a London station on a UTC host, saved to Kolkata at
  // UTC 04:30:14, which is IST 10:00:14. The 10 o'clock grid hour holds a
  // different show in each zone's reading, so the show moves too.
  const s = {
    shows: [{ id: 'clean-hour', name: 'Clean Hour' }, { id: 'morning', name: 'Morning' }],
    schedule: { 1: { 4: 'clean-hour', 10: 'morning' } },  // Monday 2026-11-02
    personas: [],
  } as unknown as Settings;
  onClocks('UTC', 'Europe/London', () => {
    const save = utc(2026, 11, 2, 4, 30, 14);
    let saved = false;
    const rolls = rollsFrom(utc(2026, 11, 2, 4, 0), 92, {
      settings: () => s,
      before: t => {
        if (!saved && t.getTime() > save.getTime()) { setStationTimezone('Asia/Kolkata'); saved = true; }
      },
    });
    assert.deepEqual(rolls, ['2026-11-02T04:00', '2026-11-02T04:31', '2026-11-02T05:30'],
      'London 04:00, then the tick after the save, then IST 11:00');
    assert.equal(resolveActiveShow(utc(2026, 11, 2, 4, 31), s)?.id, 'morning', 'the new zone puts the morning show on');
    // The hourly row at UTC 05:00 (IST 10:30) pairs with the save's roll.
    assert.equal(stationHourKey(utc(2026, 11, 2, 5, 0)), stationHourKey(utc(2026, 11, 2, 4, 31)));
  });
});

test('a schedule edit that changes the show on air rolls on the next tick', () => {
  const s = {
    shows: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    schedule: { 1: { 10: 'a', 11: 'a' } },
    personas: [],
    scheduleOverride: null as unknown,
  };
  const settings = () => s as unknown as Settings;
  onClocks('UTC', 'Europe/London', () => {
    const ten = utc(2026, 11, 2, 10, 0);
    const edits: Record<string, () => void> = {
      '10:20': () => { s.schedule = { 1: { 10: 'b', 11: 'a' } }; },             // the hour on air: rolls at 10:21
      '10:30': () => { s.schedule = { 1: { 10: 'b', 11: 'b' } }; },             // a later hour: no roll now
      '10:40': () => { s.shows = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B2' }]; }, // the show's own fields: no roll
    };
    const rolls = rollsFrom(ten, 75, {
      boot: new Date(ten.getTime() - 30_000),
      settings,
      // An edit saved during minute HH:MM is seen by the next tick.
      before: t => { edits[plus(t, -1).toISOString().slice(11, 16)]?.(); },
    });
    assert.deepEqual(rolls, ['2026-11-02T10:00', '2026-11-02T10:21', '2026-11-02T11:00']);
  });
});

test('a takeover running out rolls on the tick it ends, a schedule-free hour included', () => {
  const ten = utc(2026, 11, 2, 10, 0);
  const s = {
    shows: [{ id: 'pinned', name: 'Pinned' }],
    schedule: {},
    personas: [],
    scheduleOverride: { showId: 'pinned', startedAt: ten.getTime() - 3_600_000, expiresAt: plus(ten, 25).getTime() },
  } as unknown as Settings;
  onClocks('UTC', 'Europe/London', () => {
    assert.deepEqual(
      rollsFrom(plus(ten, 1), 60, { boot: plus(ten, 0), settings: () => s }),
      ['2026-11-02T10:25', '2026-11-02T11:00'],
    );
  });
});

// talkTick's pairing: roll when the position moved and remember it by station
// hour, then hand the hourly row the roll made in this station hour. The row's
// ten-minute window is still on process minutes (#1500); what it must see is
// the roll that opened its station hour, since that roll's `showStarted` is
// what earns the hourly welcome and its `introAired` is what stands the check
// down.
function hourlyRowSees(from: Date, minutes: number) {
  const hourly = talkSlot('hourly');
  let last: StationPosition | null = positionAt(new Date(from.getTime() - 30_000));
  let lastRoll: { hourKey: string; at: Date } | null = null;
  const seen: { tick: string; rolled: string | null }[] = [];
  for (let i = 0; i < minutes; i++) {
    const now = plus(from, i);
    const position = positionAt(now);
    if (sessionRollDue(last, position)) {
      last = position;
      lastRoll = { hourKey: stationHourKey(now), at: now };
    }
    const rolled = lastRoll?.hourKey === stationHourKey(now) ? lastRoll : null;
    // A walk that starts mid-hour has booted into it, and a boot has no roll
    // to pair with (talkEligible asks suppressHourly for that reason).
    if (lastRoll && openMinuteFor(hourly, now.getMinutes()) != null) {
      seen.push({ tick: at(now), rolled: rolled ? at(rolled.at) : null });
    }
  }
  return seen;
}

test('the hourly row still finds the roll that opened its station hour', () => {
  const cases: { host: string; zone: string; from: Date; minutes: number; onTheHour: boolean }[] = [
    ...Object.entries(TEN_OCLOCK).map(([zone, change]) => ({ host: 'UTC', zone, from: plus(change, -60), minutes: 180, onTheHour: true })),
    { host: 'Asia/Kolkata', zone: 'Europe/London', from: plus(TEN_OCLOCK['Europe/London'], -60), minutes: 180, onTheHour: true },
    ...LONDON_CHANGES.flatMap(c => ['UTC', 'Asia/Kolkata'].map(host => ({ host, zone: 'Europe/London', from: c.from, minutes: 240, onTheHour: true }))),
    // A transition hour with no :00 rolls at its first minute instead.
    ...FRACTIONAL_DST.map(c => ({ host: 'UTC', zone: c.zone, from: c.from, minutes: c.minutes, onTheHour: false })),
  ];
  for (const c of cases) {
    onClocks(c.host, c.zone, () => {
      const seen = hourlyRowSees(c.from, c.minutes);
      assert.ok(seen.length >= 10, `${c.zone} on ${c.host}: the walk spans an hourly window`);
      for (const { tick, rolled } of seen) {
        assert.ok(rolled, `${c.zone} on ${c.host}: the hourly row at ${tick} found no roll`);
        const roll = new Date(`${rolled}Z`);
        const now = new Date(`${tick}Z`);
        if (c.onTheHour) {
          assert.equal(zonedParts(roll).minute, 0, `${c.zone} on ${c.host}: the ${tick} check paired with a roll off the station's :00 (${rolled})`);
        }
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
          assert.equal(stationHourKey(now), processHourKey(now), `${host} at ${at(now)}`);
          assert.equal(stationHourStartProcessMinute(now), 0, `${host} at ${at(now)}`);
        }
        // Every roll lands on a process :00.
        for (const r of rollsFrom(from, 6 * 60)) assert.equal(new Date(`${r}Z`).getMinutes(), 0, `${host}: roll at ${r}`);
      }
    });
  }
});

test("the station's :00 as a process minute", () => {
  const t = utc(2026, 11, 2, 7, 10);
  const cases: Record<string, number> = {
    'Europe/London': 0, 'Asia/Tokyo': 0, 'Asia/Kolkata': 30, 'Asia/Kathmandu': 15, 'America/St_Johns': 30, 'Pacific/Chatham': 15,
  };
  for (const [zone, minute] of Object.entries(cases)) {
    onClocks('UTC', zone, () => assert.equal(stationHourStartProcessMinute(t), minute, `${zone} on UTC`));
  }
  onClocks('Asia/Kathmandu', 'Europe/London', () => assert.equal(stationHourStartProcessMinute(t), 45, 'London on a Nepal host'));
});

test('talkTick rolls on a moved position, seeded at start, and pairs on the station clock', () => {
  const scheduler = readFileSync(new URL('../src/broadcast/scheduler.ts', import.meta.url), 'utf8');
  const start = scheduler.indexOf('async function talkTick');
  assert.ok(start >= 0, 'talkTick moved');
  const tick = scheduler.slice(start, scheduler.indexOf('\n}\n', start));
  assert.match(tick, /const position = currentStationPosition\(now\);\s*if \(sessionRollDue\(lastTickPosition\(\), position\)\) \{\s*markRolledPosition\(position\);/,
    'the roll fires when the station hour or show moved');
  assert.match(tick, /lastRoll = roll \? \{ hourKey: stationHourKey\(now\), roll \} : null;/, 'the roll is remembered by station hour');
  assert.match(tick, /lastRoll\?\.hourKey === stationHourKey\(now\)/, 'the hourly row looks it up by station hour');
  assert.doesNotMatch(tick, /now\.get(Minutes|Hours|Date|Month|FullYear)\(\)/, 'no process-clock read decides the roll');
  assert.doesNotMatch(scheduler, /isStationHourStart/, 'the minute-0 edge test is gone');
  assert.match(scheduler, /return stationPosition\(stationHourKey\(now\), stationUtcOffsetMinutes\(now\), settings\.resolveActiveShow\(now\)\);/,
    'the position is the station hour, its offset and the resolved active show');

  // Every roll records the position, so a route's roll is not repeated by the tick.
  const roll = scheduler.slice(scheduler.indexOf('export async function rollSessionNow'));
  assert.match(roll, /^[^]*?\) \{\s*(\/\/.*\n\s*)*markRolledPosition\(\);/, 'rollSessionNow records the position first');

  // The baseline is seeded by startScheduler, before the tick is registered.
  const boot = scheduler.slice(scheduler.indexOf('export function startScheduler'));
  assert.ok(boot.indexOf('markRolledPosition();') >= 0, 'startScheduler seeds the baseline');
  assert.ok(boot.indexOf('markRolledPosition();') < boot.indexOf("cron.schedule('* * * * *', talkTick);"), 'before the first tick can run');
});
