// Pins the talk slot table and its arbitration (broadcast/talk-scheduler.ts).
// One per-minute tick over a table of windowed rows: postpone-never-cancel,
// one talker per minute (#310), and a row yields only to a row that is FIRING.
// STATE_DIR is redirected before the first import, hence the dynamic imports.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Types only, erased at build time, so nothing loads before STATE_DIR is set.
import type { TalkKind, TalkPlan } from '../src/broadcast/talk-scheduler.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-talk-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const {
  TALK_SLOTS, talkSlot, talkTickPlan, talkSlotPlan, talkGap, talkSlotKey,
  openMinuteFor, windowEndMinute, canRetry, standDownLine, missedLine,
} = await import('../src/broadcast/talk-scheduler.js');
const { BANTER_SLOTS, BANTER_WINDOW_MINUTES, BANTER_MIN_GAP_MS } = await import('../src/broadcast/banter-policy.js');
const { PENDING_VOICE_MAX_AGE_MS } = await import('../src/broadcast/queue/kinds.js');
const { shouldFire } = await import('../src/broadcast/dj-gate.js');
const { zonedParts } = await import('../src/time.js');

// The default roster's first persona, re-fadered to the frequency under test.
// Patching the seeded persona keeps the strict TTS/soul validators happy.
async function station(frequency: string) {
  await settings.update({
    tts: { enabled: true },
    personas: settings.get().personas.map((p: any, i: number) =>
      (i === 0 ? { ...p, frequency, djMode: false } : p)),
  } as any);
}

const HOUR = 9;
const at = (minute: number, hour = HOUR) => new Date(2026, 7, 19, hour, minute, 0);
const clockAt = (minute: number, second = 0, hour = HOUR) =>
  new Date(2026, 7, 19, hour, minute, second).getTime();

// Drives the planner exactly as scheduler.talkTick does. `feedback` closes the
// loop: a segment that airs sets the quiet gap for every row after it.
function makeReplay(opts: {
  lastTalkBreakAt?: number;
  feedback?: boolean;
  // A function when the clip's presence has to change mid-hour.
  pendingTalk?: { kind: string; queuedAt: number } | null
    | ((now: Date) => { kind: string; queuedAt: number } | null);
  betweenTracksOnly?: boolean;
  eligible?: (kind: TalkKind, now: Date) => boolean;
  externalSlot?: (kind: TalkKind, now: Date) => string | null;
} = {}) {
  const fired: Partial<Record<TalkKind, string | null>> = {};
  const logged: Partial<Record<TalkKind, string | null>> = {};
  const rang: { minute: number; kind: TalkKind; slot: string; air: string }[] = [];
  const logs: string[] = [];
  let lastTalkBreakAt = opts.lastTalkBreakAt ?? 0;
  const tick = (now: Date) => {
    const plans: TalkPlan[] = talkTickPlan({
      now,
      lastTalkBreakAt,
      pendingTalk: (typeof opts.pendingTalk === 'function'
        ? opts.pendingTalk(now)
        : opts.pendingTalk) ?? null,
      betweenTracksOnly: opts.betweenTracksOnly ?? false,
      // Default: every row is eligible EXCEPT the jingle rotate, which mirrors
      // the station a test without an `eligible` of its own is describing.
      // `jingle` (#1619) is the one row gated on an opt-in setting — a station
      // that has not set `jingleRotate: 'controller'` never offers it a minute,
      // and radio.liq is still drawing the stinger itself. Tests that want the
      // row pass their own resolver.
      eligible: kind => (opts.eligible ? opts.eligible(kind, now) : kind !== 'jingle'),
      externalSlot: kind => (opts.externalSlot ? opts.externalSlot(kind, now) : null),
      fired,
      logged,
    });
    for (const plan of plans) {
      if (plan.act === 'wait') {
        if (plan.markLogged) logged[plan.kind] = plan.markLogged;
        if (plan.log) logs.push(plan.log);
        continue;
      }
      fired[plan.kind] = plan.slotKey;
      rang.push({ minute: now.getMinutes(), kind: plan.kind, slot: plan.slot, air: plan.air });
      if (opts.feedback) lastTalkBreakAt = now.getTime();
    }
    return plans;
  };
  const hour = (hourOf = HOUR) => { for (let m = 0; m < 60; m++) tick(at(m, hourOf)); };
  return { tick, hour, rang, logs, minutesOf: (k: TalkKind) => rang.filter(r => r.kind === k).map(r => r.minute) };
}

test('a quiet hour is unchanged — every row still fires on the minute its cron did', async () => {
  const identMinutes = (f: string) => (f === 'quiet' ? [45] : f === 'moderate' ? [15, 45] : [15, 30, 45]);
  const banterMinutes = (f: string) => (f === 'quiet' ? [] : f === 'moderate' ? [20] : [20, 50]);

  for (const frequency of ['quiet', 'moderate', 'chatty', 'aggressive']) {
    await station(frequency);
    // Two hours, so the quiet rung's every-other-station-hour check is exercised.
    for (const hour of [9, 10]) {
      const r = makeReplay({
        feedback: true,
        eligible: (kind, now) => {
          if (kind === 'programme') return false;  // covered on its own below
          if (kind === 'jingle') return false;     // opt-in (#1619) — covered on its own below
          return shouldFire(kind === 'station-id' ? 'stationId' : kind, now);
        },
      });
      r.hour(hour);
      const expectHourly = (frequency !== 'quiet' || zonedParts(at(0, hour)).hour % 2 === 0) ? [0] : [];
      assert.deepEqual(r.minutesOf('hourly'), expectHourly, `${frequency} @${hour}: hourly`);
      assert.deepEqual(r.minutesOf('station-id'), identMinutes(frequency), `${frequency} @${hour}: idents`);
      assert.deepEqual(r.minutesOf('banter'), banterMinutes(frequency), `${frequency} @${hour}: banter`);
      assert.deepEqual(r.logs, [], `${frequency} @${hour}: a clear hour explains nothing`);
    }
  }
});

test('two rows never open a new chance on the same minute — #310 as a table property', () => {
  // Windows overlap now, so #310 survives as: no two rows OPEN on the same minute.
  const opens = new Map<number, TalkKind>();
  for (const row of TALK_SLOTS) {
    // A row with no scheduled minutes has nothing to collide: 'external' places
    // itself on someone else's clock, and 'any' (both fill rows) opens a fresh
    // chance on every tick it is sampled on, which is what makes it a fill row
    // rather than an owner of minutes. #310 is a rule about SCHEDULED minutes.
    if (row.opens === 'external' || row.opens === 'any') continue;
    for (const m of row.opens) {
      assert.equal(opens.get(m), undefined, `:${m} opens both ${opens.get(m)} and ${row.kind}`);
      opens.set(m, row.kind);
    }
  }
  // The hourly check owns :00; the ident row must not open there.
  assert.equal(openMinuteFor(talkSlot('station-id'), 0), null);
  assert.equal(openMinuteFor(talkSlot('station-id'), 20), 15);
  assert.equal(openMinuteFor(talkSlot('banter'), 20), 20);
});

test('the table carries real windows and real gaps, banter widest', () => {
  // Banter is the longest break the station airs, so it holds out for the most quiet.
  assert.equal(talkSlot('banter').minGapMs, BANTER_MIN_GAP_MS);
  assert.equal(talkSlot('banter').windowMinutes, BANTER_WINDOW_MINUTES);
  for (const kind of ['hourly', 'station-id'] as TalkKind[]) {
    assert.ok(talkSlot(kind).windowMinutes > 1, `${kind} must be able to retry`);
    assert.ok(talkSlot(kind).minGapMs > 0, `${kind} must respect a quiet gap`);
    assert.ok(talkSlot(kind).minGapMs < BANTER_MIN_GAP_MS, `${kind} should be less demanding than banter`);
  }
  // The programme beat cannot retry, so it leads the priority order and takes no gap.
  assert.equal(talkSlot('programme').minGapMs, 0);
  assert.equal(Math.min(...TALK_SLOTS.map(r => r.priority)), talkSlot('programme').priority);
  // The ordering principle: fewer chances in the hour outranks more.
  assert.ok(talkSlot('hourly').priority < talkSlot('banter').priority);
  assert.ok(talkSlot('banter').priority < talkSlot('station-id').priority);
});

test('per-row air mode and clock survive the merge', () => {
  // An ident defers to the next track boundary; everything else airs immediately.
  assert.equal(talkSlot('station-id').air, 'next-track');
  for (const kind of ['hourly', 'banter', 'programme'] as TalkKind[]) {
    assert.equal(talkSlot(kind).air, 'immediate', `${kind} must air immediately`);
  }
  // Slot minutes are process time; programme beats are a station-zone fact.
  assert.equal(talkSlot('programme').clock, 'station');
  for (const kind of ['hourly', 'banter', 'station-id'] as TalkKind[]) {
    assert.equal(talkSlot(kind).clock, 'process', `${kind} slots are process minutes`);
  }
});

test('a disrupted hour postpones every row instead of dropping it', async () => {
  await station('aggressive');
  // An off-clock spot at :14 leaves the :15 ident waiting out its three-minute gap.
  const r = makeReplay({
    lastTalkBreakAt: clockAt(14),
    feedback: true,
    eligible: (kind, now) => kind !== 'programme' && shouldFire(kind === 'station-id' ? 'stationId' : kind, now),
  });
  for (let m = 15; m < 30; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('station-id'), [17], 'the ident postpones to the first clear minute');
  // Banter needs five clear minutes, so it takes :22 rather than losing the slot.
  assert.deepEqual(r.minutesOf('banter'), [22]);
  assert.equal(r.logs.length, 2);
  assert.match(r.logs[0], /^\[station-id\] stood down at :15 — last standalone talk 60s ago, minimum gap 180s \(retrying until :24\)$/);
  assert.match(r.logs[1], /^\[banter\] stood down at :20 — last standalone talk \d+s ago, minimum gap 300s \(retrying until :29\)$/);
});

test("the reporter's hour: a :19:35 ident postpones the exchange, it no longer cancels it", () => {
  // #1419: a :15 ident boundary-deferred to 09:19:35 used to cancel the exchange.
  const r = makeReplay({
    lastTalkBreakAt: clockAt(19, 35),
    eligible: kind => kind === 'banter',
  });
  for (let m = 20; m <= 29; m++) r.tick(at(m));
  // The gap clears at :24:35, so :24 is still short (265s) and :25 is the first minute.
  assert.deepEqual(r.minutesOf('banter'), [25]);
  assert.equal(r.logs.length, 1, 'one stand-down for the slot, not one per blocked minute');
  assert.match(r.logs[0], /^\[banter\] stood down at :20 — last standalone talk 25s ago/);
});

test('a slot fires at most once, however many minutes are left in the window', () => {
  const r = makeReplay({ eligible: kind => kind === 'banter' });
  for (let m = 20; m <= 29; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('banter'), [20], 'the slot opens, airs once, and stays quiet');
  assert.deepEqual(r.logs, []);
  for (let m = 50; m <= 52; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('banter'), [20, 50], 'the :50 window is its own chance');
});

test('a window that never clears says so once, at the minute it is lost', () => {
  const r = makeReplay({ lastTalkBreakAt: clockAt(24, 30), eligible: kind => kind === 'banter' });
  for (let m = 20; m <= 29; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('banter'), [], 'the gap never clears inside this window');
  assert.equal(r.logs.length, 2, 'one stand-down at :20, one "missed" at :29');
  assert.match(r.logs[0], /stood down at :20/);
  assert.match(r.logs[1], /^\[banter\] slot :20 missed — .*window closed at :29$/);
  // The last minute being the first blocked one still reports, with numbers.
  const only = makeReplay({ lastTalkBreakAt: clockAt(28, 30), eligible: kind => kind === 'banter' });
  only.tick(at(29));
  assert.deepEqual(only.minutesOf('banter'), []);
  assert.equal(only.logs.length, 1);
  assert.match(only.logs[0], /slot :20 missed — last standalone talk 30s ago/);
});

test('every row logs its stand-down now, not just banter', () => {
  for (const [kind, open] of [['hourly', 0], ['station-id', 15], ['banter', 20]] as const) {
    const r = makeReplay({ lastTalkBreakAt: clockAt(open, 0), eligible: k => k === kind });
    r.tick(at(open + 1));
    assert.equal(r.logs.length, 1, `${kind} must report standing down`);
    assert.match(r.logs[0], new RegExp(`^\\[${kind}\\] stood down at :${open} — last standalone talk 60s ago`));
  }
});

test('when two rows would both fire, priority takes the minute and the loser waits', () => {
  // :20 is the overlap: banter's chance opens while the ident's :15 window still runs.
  const r = makeReplay({ eligible: kind => kind === 'banter' || kind === 'station-id' });
  const plans = r.tick(at(20));
  assert.deepEqual(plans.map(p => `${p.kind}:${p.act}`), ['banter:fire', 'station-id:wait']);
  assert.deepEqual(r.minutesOf('banter'), [20]);
  assert.deepEqual(r.minutesOf('station-id'), [], 'the ident does not also speak');
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /^\[station-id\] stood down at :15 — banter took the minute \(retrying until :24\)$/);
});

test('a yielded slot is postponed, not cancelled', () => {
  const r = makeReplay({ eligible: kind => kind === 'banter' || kind === 'station-id' });
  r.tick(at(20));
  r.tick(at(21));
  assert.deepEqual(r.minutesOf('banter'), [20]);
  assert.deepEqual(r.minutesOf('station-id'), [21]);
});

test('a row yields only to a row that is FIRING, never to one that is merely open', () => {
  // Banter is open across :20-:29 but blocked on its five-minute gap; the ident
  // needs three. Yielding to a merely-open row hands #1419 back one layer up.
  // Talk aired at :21:00, so at :24 the ident is clear and banter is not.
  const r = makeReplay({
    lastTalkBreakAt: clockAt(21),
    eligible: kind => kind === 'banter' || kind === 'station-id',
  });
  const plans = r.tick(at(24));
  assert.deepEqual(plans.map(p => `${p.kind}:${p.act}`), ['banter:wait', 'station-id:fire']);
  assert.deepEqual(r.minutesOf('station-id'), [24]);
});

test('a programme beat outranks the hourly check, because a beat cannot retry', () => {
  // A :30-offset station zone puts a feature beat (:35-:39) at process :05, inside
  // the hourly row's window. The beat has no window of its own.
  const r = makeReplay({
    eligible: kind => kind === 'programme' || kind === 'hourly',
    externalSlot: kind => (kind === 'programme' ? 'feature' : null),
  });
  const plans = r.tick(at(5));
  assert.deepEqual(plans.map(p => `${p.kind}:${p.act}`), ['programme:fire', 'hourly:wait']);
  assert.match(r.logs[0], /^\[hourly\] stood down at :0 — programme took the minute/);
  r.tick(at(6));
  assert.deepEqual(r.minutesOf('hourly'), [6]);
});

test('the segment director is offered the same minutes its cron fired on', () => {
  const r = makeReplay({ eligible: kind => kind === 'segment' });
  r.hour();
  assert.deepEqual(r.minutesOf('segment'), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.equal(talkSlot('segment').role, 'fill');
  // How often it actually speaks stays in skills/_agent.ts, so the row has no gap.
  assert.equal(talkSlot('segment').minGapMs, 0);
});

test('the filler stands down for a slot row that is merely WAITING, not just firing', () => {
  // A talk break at :14 leaves the :15 ident waiting. The director used to fire at
  // :15 anyway and push the ident to :18; now it stands down and the ident takes :17.
  const r = makeReplay({
    lastTalkBreakAt: clockAt(14),
    feedback: true,
    eligible: kind => kind === 'segment' || kind === 'station-id',
  });
  for (let m = 15; m <= 20; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('station-id'), [17], 'the ident is no longer pushed out');
  // :15 was contested and yielded; :20 is free. The filler stands down for a
  // contested MINUTE, not for an open window.
  assert.deepEqual(r.minutesOf('segment'), [20]);
});

test("a contested minute never reaches the filler's own gates", () => {
  const asked: TalkKind[] = [];
  const r = makeReplay({ eligible: kind => { asked.push(kind); return true; } });
  r.tick(at(15));  // the ident's chance opens
  assert.deepEqual(asked, ['station-id'], 'the filler is not even asked');
  asked.length = 0;
  // :10 and :40 are the only stride ticks no slot row's WINDOW can reach at
  // all, so they are free whatever else has happened this hour.
  r.tick(at(10));
  // Both fill rows, in table order: the segment director and the jingle rotate
  // (#1619). A free minute is offered to every filler; a contested one to none.
  assert.deepEqual(asked, ['segment', 'jingle']);
});

test('the filler yields to a firing row, and takes the minutes nothing else wants', () => {
  // A clean, chatty hour: the filler loses the six opening minutes and keeps
  // A clean, chatty hour: the filler loses the six opening minutes and keeps six.
  const r = makeReplay({ feedback: true });
  r.hour();
  assert.deepEqual(r.minutesOf('hourly'), [0]);
  assert.deepEqual(r.minutesOf('station-id'), [15, 30, 45]);
  assert.deepEqual(r.minutesOf('banter'), [20, 50]);
  assert.deepEqual(r.minutesOf('segment'), [5, 10, 25, 35, 40, 55]);
  // At most one talker per minute.
  const minutes = r.rang.map(x => x.minute);
  assert.equal(new Set(minutes).size, minutes.length, 'two segments aired in one minute');
});

test('deferring to an OPEN window rather than a wanted minute would switch the filler off', () => {
  // The rule is "a slot row wants this minute", not "its window is open": with
  // ten-minute windows the looser reading would leave the director only :10 and :40.
  const covered = new Set<number>();
  for (const row of TALK_SLOTS) {
    if (row.opens === 'external' || row.opens === 'any') continue;
    for (const open of row.opens) {
      for (let i = 0; i < row.windowMinutes; i++) covered.add(open + i);
    }
  }
  const strideTicks = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  assert.deepEqual(strideTicks.filter(m => !covered.has(m)), [10, 40], 'the reading NOT taken');
  const r = makeReplay({ feedback: true });
  r.hour();
  assert.equal(r.minutesOf('segment').length, 6, 'the reading taken');
});

test('the filler never narrates its own stand-down', () => {
  // A filler that did not fill is not an event; a scheduled segment that quietly
  // did not happen is #1419, and those still log.
  const r = makeReplay({ feedback: true });
  r.hour();
  assert.equal(r.logs.filter(l => l.startsWith('[segment]')).length, 0);
  assert.deepEqual(r.logs, [], 'a clear hour explains nothing at all');
});

test('a segment waiting for a track boundary holds every gap-gated row', () => {
  // #1419's root cause: getLastTalkBreakAt() reports what HAS aired, so a rendered
  // ident waiting on a boundary is invisible to it. `pendingTalk` carries the
  // queue's `_pendingVoice` kind and enqueue time.
  const r = makeReplay({
    pendingTalk: { kind: 'station-id', queuedAt: clockAt(15) },
    eligible: kind => kind === 'banter',
  });
  r.tick(at(20));
  assert.deepEqual(r.minutesOf('banter'), [], 'in-flight talk is still talk');
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /^\[banter\] stood down at :20 — a station-id is rendered and waiting for the next track boundary \(retrying until :29\)$/);
  const after = makeReplay({ eligible: kind => kind === 'banter' });
  after.tick(at(21));
  assert.deepEqual(after.minutesOf('banter'), [21]);
});

test('a pending segment fresh enough to outlast a window holds it — and says so', () => {
  // A freshly rendered ident can still validly air across this window, so the hold
  // stands for every minute of it except the last.
  const r = makeReplay({
    pendingTalk: { kind: 'station-id', queuedAt: clockAt(20) },
    eligible: kind => kind === 'banter',
  });
  for (let m = 20; m <= 28; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('banter'), []);
  assert.equal(r.logs.length, 1, 'said once per slot, not once per minute');
  assert.match(r.logs[0], /^\[banter\] stood down at :20 — a station-id is rendered and waiting for the next track boundary \(retrying until :29\)$/);
});

test('a held row still fires inside its window — the hold never costs the final chance', () => {
  // #1539: `_pendingVoice` may live PENDING_VOICE_MAX_AGE_MS and is dropped only at
  // a track start, so a clip can outlast the window of the row it is holding. The
  // window's last minute is the row's final chance, and the hold stands down for it.
  // The enqueue times below are ones the rows themselves produce.
  const cases = [
    { label: 'hourly :00-:09 behind an ident queued at :51', kind: 'hourly' as TalkKind, open: 0, last: 9, queuedAt: clockAt(51, 0, HOUR - 1) },
    { label: 'banter :50-:59 behind an ident queued at :45', kind: 'banter' as TalkKind, open: 50, last: 59, queuedAt: clockAt(45) },
  ];
  for (const { label, kind, open, last, queuedAt } of cases) {
    const r = makeReplay({
      pendingTalk: { kind: 'station-id', queuedAt },
      eligible: k => k === kind,
    });
    for (let m = open; m <= last; m++) r.tick(at(m));
    assert.deepEqual(r.minutesOf(kind), [last], `${label}: postponed to its last minute, not cancelled`);
    assert.equal(r.logs.length, 1, `${label}: held once, then took the minute`);
    assert.match(
      r.logs[0],
      new RegExp(`^\\[${kind}\\] stood down at :${open} — a station-id is rendered and waiting for the next track boundary \\(retrying until :${last}\\)$`),
      label,
    );
    assert.equal(r.logs.some(line => line.includes('missed')), false, `${label}: a held row postpones, never cancels`);
  }
});

test('the last-chance release is the row\'s alone — a clip that expires in the window never holds at all', () => {
  // The other end of the bound: a clip that expires before this window closes was
  // never able to cost the row its slot, so it does not hold even at the opening minute.
  const r = makeReplay({
    pendingTalk: { kind: 'station-id', queuedAt: clockAt(50, 0, HOUR - 1) },
    eligible: kind => kind === 'hourly',
  });
  for (let m = 0; m <= 9; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('hourly'), [0], 'expires at :10, exactly when the window closes — the row keeps all ten minutes');
  assert.deepEqual(r.logs, []);
});

test('two simulated hours: a pending clip never eats a whole window, whatever else is happening', () => {
  // Drives the whole table for two hours against pseudo-random pending clips, quiet
  // gaps and eligibility. The old comparison read the same at every minute of a
  // window, so only the whole window showed the loss. Seeded, so a failure repeats.
  const rand = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const minuteAt = (i: number) => new Date(2026, 7, 19, HOUR + Math.floor(i / 60), i % 60, 0);
  const TICKS = 120;
  let fullyPendingWindows = 0, lastMinutePendingHolds = 0, pendingHolds = 0, released = 0;

  for (let seed = 1; seed <= 12; seed++) {
    const rnd = rand(seed);
    // A boundary-deferred clip lands at random minutes and sits until it goes stale.
    const live: ({ kind: string; queuedAt: number } | null)[] = new Array(TICKS).fill(null);
    for (let i = 0; i < TICKS; i++) {
      if (rnd() >= 0.25) continue;
      const queuedAt = minuteAt(i).getTime() - Math.floor(rnd() * 21) * 60_000;
      for (let j = i; j < TICKS && minuteAt(j).getTime() - queuedAt <= PENDING_VOICE_MAX_AGE_MS; j++) {
        live[j] = { kind: 'station-id', queuedAt };
      }
    }
    const beats = new Set<number>();
    const inelig = new Set<string>();
    const breaks: number[] = [];
    for (let i = 0; i < TICKS; i++) {
      if (i % 5 === 0 && rnd() < 0.35) beats.add(i);
      for (const row of TALK_SLOTS) if (rnd() < 0.12) inelig.add(`${row.kind}:${i}`);
      breaks.push(rnd() < 0.15 ? 0 : minuteAt(i).getTime() - Math.floor(rnd() * 9) * 60_000);
    }

    const fired: Partial<Record<TalkKind, string | null>> = {};
    const logged: Partial<Record<TalkKind, string | null>> = {};
    const window = new Map<string, string[]>();
    let lastTalkBreakAt = breaks[0];
    for (let i = 0; i < TICKS; i++) {
      const now = minuteAt(i);
      const plans: TalkPlan[] = talkTickPlan({
        now, lastTalkBreakAt,
        pendingTalk: live[i],
        eligible: kind => !inelig.has(`${kind}:${i}`),
        externalSlot: kind => (kind === 'programme' && beats.has(i) ? `beat${i}` : null),
        fired, logged,
      });

      // One talker per minute (#310) survives the release.
      const firing = plans.filter(p => p.act === 'fire');
      assert.ok(firing.length <= 1, `seed ${seed} :${now.getMinutes()} — ${firing.map(p => p.kind)} all fired`);

      // The fill row stands down, silently, to any slot row that wants the minute.
      const slotWants = plans.some(p => TALK_SLOTS.some(r => r.kind === p.kind && r.role === 'slot'));
      const fillPresent = plans.some(p => TALK_SLOTS.some(r => r.kind === p.kind && r.role === 'fill'));
      assert.ok(!(slotWants && fillPresent), `seed ${seed} :${now.getMinutes()} — the fill row spoke over a slot row`);

      for (const plan of plans) {
        const row = talkSlot(plan.kind);
        const held = plan.act === 'wait' ? plan.reason.held : 'fire';
        if (held === 'pending') {
          pendingHolds++;
          // `minGapMs: 0` has opted out of the question entirely.
          assert.notEqual(row.minGapMs, 0, `seed ${seed} :${now.getMinutes()} — ${plan.kind} has no gap yet held on pending`);
          // THE HOLD NEVER TAKES THE ROW'S LAST CHANCE. #1539 in one line — for
          // a row that HAS a last chance. An `opens: 'any'` row cannot lose one
          // by waiting (the next tick is another), so its hold is unbounded on
          // purpose and the bound would read as "never held at all".
          //
          // `minGapMs > 0` narrows the exemption to the row it was written for.
          // The segment director is `opens: 'any'` too and predates #1619, so
          // the bare `opens === 'any'` test quietly stopped pinning anything for
          // it — inertly today (its `minGapMs: 0` makes pendingHolds return
          // before the branch), but this assertion is the guard, not the
          // implementation, and it must not be the half that goes slack first.
          assert.ok(row.opens === 'external' || (row.opens === 'any' && row.minGapMs > 0)
            || canRetry(row, plan.slot, now.getMinutes()),
            `seed ${seed} :${now.getMinutes()} — ${plan.kind} held on pending at its window's last minute (slot :${plan.slot})`);
        }
        if (row.opens !== 'external' && row.windowMinutes > 1) {
          const key = `${plan.kind}|${plan.slotKey}`;
          const acts = window.get(key) ?? [];
          acts.push(held);
          window.set(key, acts);
        }
        if (plan.act === 'wait') { if (plan.markLogged) logged[plan.kind] = plan.markLogged; }
        else { fired[plan.kind] = plan.slotKey; lastTalkBreakAt = now.getTime(); }
      }
      if (plans.every(p => p.act !== 'fire')) lastTalkBreakAt = Math.max(lastTalkBreakAt, breaks[i]);
    }

    for (const [key, acts] of window) {
      const row = talkSlot(key.split('|')[0] as TalkKind);
      if (acts.some(a => a === 'pending') && acts.some(a => a !== 'pending')) released++;
      if (acts.length === row.windowMinutes && acts.every(a => a === 'pending')) {
        fullyPendingWindows++;
        lastMinutePendingHolds++;
      }
    }
  }

  assert.equal(fullyPendingWindows, 0, 'no row may lose a whole window to a pending clip — that is a cancel, not a postpone');
  assert.equal(lastMinutePendingHolds, 0);
  assert.ok(pendingHolds > 100, `the run must actually exercise the hold (saw ${pendingHolds} held minutes)`);
  assert.ok(released > 20, `and must actually exercise the release (saw ${released} windows held then released)`);
});

test('pending expiry before or at the hourly window close preserves the scheduled row', () => {
  const hourlyClose = clockAt(10);
  const cases = [
    { label: 'before', now: at(0), queuedAt: hourlyClose - PENDING_VOICE_MAX_AGE_MS - 1 },
    { label: 'equal', now: at(0), queuedAt: hourlyClose - PENDING_VOICE_MAX_AGE_MS },
    {
      label: 'equal with seconds',
      now: new Date(2026, 7, 19, HOUR, 0, 30, 250),
      queuedAt: hourlyClose - PENDING_VOICE_MAX_AGE_MS,
    },
  ];
  for (const { label, now, queuedAt } of cases) {
    const r = makeReplay({
      pendingTalk: { kind: 'station-id', queuedAt },
      eligible: kind => kind === 'hourly',
    });
    const plans = r.tick(now);
    r.tick(at(1));
    assert.deepEqual(plans.map(p => `${p.kind}:${p.act}`), ['hourly:fire'], label);
    assert.deepEqual(r.minutesOf('hourly'), [0], label);
    assert.equal(r.logs.some(line => line.includes('missed')), false, label);
  }
});

test('a bounded-out pending segment still honours the real quiet gap', () => {
  const now = at(0);
  const r = makeReplay({
    lastTalkBreakAt: now.getTime() - 60_000,
    pendingTalk: {
      kind: 'station-id',
      queuedAt: clockAt(10) - PENDING_VOICE_MAX_AGE_MS,
    },
    eligible: kind => kind === 'hourly',
  });
  const plans = r.tick(now);
  assert.deepEqual(plans.map(p => `${p.kind}:${p.act}`), ['hourly:wait']);
  assert.equal(plans[0]?.act === 'wait' ? plans[0].reason.held : null, 'gap');
  assert.match(r.logs[0], /last standalone talk 60s ago/);
});

test('a future pending timestamp is clamped instead of extending the queue lifetime', () => {
  const now = at(0);
  const row = { ...talkSlot('hourly'), windowMinutes: 20 };
  const plan = talkSlotPlan(row, {
    now,
    lastTalkBreakAt: 0,
    pendingTalk: { kind: 'station-id', queuedAt: now.getTime() + 60_000 },
    eligible: () => true,
    externalSlot: () => null,
    fired: {},
    logged: {},
  });
  assert.equal(plan?.act, 'fire', 'a clock adjustment must not make a fresh clip valid for over 20 minutes');
});

test('a row with no gap ignores in-flight talk, because it has opted out of the question', () => {
  // `minGapMs: 0` means the row does not ask about quiet; a programme beat that
  // cannot retry must not be lost to a pending ident.
  const r = makeReplay({
    pendingTalk: { kind: 'station-id', queuedAt: clockAt(35) },
    eligible: kind => kind === 'programme',
    externalSlot: kind => (kind === 'programme' ? 'outro' : null),
  });
  r.tick(at(55));
  assert.deepEqual(r.minutesOf('programme'), [55]);
});

test('the ident rung reads the slot, so every retry minute keeps its chance', async () => {
  // `[15,30,45].includes(m)` would answer false for :18 and cancel every retry.
  const window = (open: number) => Array.from({ length: talkSlot('station-id').windowMinutes }, (_, i) => open + i);

  await station('quiet');
  for (const m of window(45)) assert.equal(shouldFire('stationId', at(m)), true, `quiet should retry at :${m}`);
  for (const m of [...window(15), ...window(30)]) {
    assert.equal(shouldFire('stationId', at(m)), false, `quiet must not ident at :${m}`);
  }

  await station('moderate');
  for (const m of [...window(15), ...window(45)]) {
    assert.equal(shouldFire('stationId', at(m)), true, `moderate should retry at :${m}`);
  }
  for (const m of window(30)) assert.equal(shouldFire('stationId', at(m)), false, `moderate must not ident at :${m}`);

  for (const f of ['chatty', 'aggressive']) {
    await station(f);
    for (const m of [...window(15), ...window(30), ...window(45)]) {
      assert.equal(shouldFire('stationId', at(m)), true, `${f} should ident at :${m}`);
    }
    // Outside every ident window nothing fires; :00 stays the hourly check's (#310).
    for (const m of [0, 5, 9, 14, 25, 44, 55]) {
      assert.equal(shouldFire('stationId', at(m)), false, `${f} must not ident at :${m}`);
    }
  }
});

test('a retry minute keeps its slot identity, so one window is one chance', () => {
  const row = talkSlot('banter');
  for (const slot of BANTER_SLOTS) {
    for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
      assert.equal(openMinuteFor(row, slot + i), slot, `:${slot + i} should belong to slot :${slot}`);
    }
    assert.equal(windowEndMinute(row, slot), slot + BANTER_WINDOW_MINUTES - 1);
  }
  // Stable across the window, distinct across slots, hours and days.
  const opening = talkSlotKey('banter', at(20), '20');
  for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
    assert.equal(talkSlotKey('banter', at(20 + i), '20'), opening);
  }
  assert.notEqual(talkSlotKey('banter', at(50), '50'), opening);
  assert.notEqual(talkSlotKey('banter', at(20, 10), '20'), opening);
  assert.notEqual(talkSlotKey('banter', new Date(2026, 7, 20, 9, 20, 0), '20'), opening);
  // ...and distinct across kinds, which the old single-row key didn't have to be.
  assert.notEqual(talkSlotKey('station-id', at(20), '20'), opening);
});

test('the quiet gap is measured, not rounded, and an empty log reads as infinite', () => {
  const now = 1_000_000_000_000;
  const need = BANTER_MIN_GAP_MS;
  const blocked = talkGap({ nowMs: now, lastTalkBreakAt: now - 25_000, needMs: need });
  assert.equal(blocked.clear, false);
  assert.equal(blocked.sinceMs, 25_000);
  assert.equal(talkGap({ nowMs: now + 300_000, lastTalkBreakAt: now - 25_000, needMs: need }).clear, true);
  // Exactly on the boundary counts as clear.
  assert.equal(talkGap({ nowMs: now, lastTalkBreakAt: now - need, needMs: need }).clear, true);
  // Nothing has aired yet (a fresh boot) reads as an infinite gap, not a zero one.
  const fresh = talkGap({ nowMs: now, lastTalkBreakAt: 0, needMs: need });
  assert.equal(fresh.clear, true);
  assert.equal(fresh.sinceMs, Infinity);
  // A zero-gap row is clear even against a break that just happened.
  assert.equal(talkGap({ nowMs: now, lastTalkBreakAt: now, needMs: 0 }).clear, true);
});

test('the stand-down lines carry the reason and the numbers, for all three causes', () => {
  const row = talkSlot('banter');
  const now = 1_000_000_000_000;
  const gap = talkGap({ nowMs: now, lastTalkBreakAt: now - 25_000, needMs: BANTER_MIN_GAP_MS });
  const line = standDownLine(row, '20', { held: 'gap', gap });
  assert.match(line, /^\[banter\] stood down at :20 — last standalone talk 25s ago, minimum gap 300s \(retrying until :29\)$/);
  assert.match(missedLine(row, '20', { held: 'gap', gap }), /^\[banter\] slot :20 missed — last standalone talk 25s ago, minimum gap 300s; window closed at :29$/);
  // A fresh boot has no last break — the line must not print "Infinitys".
  assert.match(standDownLine(row, '20', { held: 'gap', gap: talkGap({ nowMs: now, lastTalkBreakAt: 0, needMs: 1 }) }), /never ago/);
  // The two causes that carry no numbers still name themselves precisely.
  assert.match(standDownLine(row, '20', { held: 'pending', pendingKind: 'station-id' }), /a station-id is rendered and waiting/);
  assert.match(standDownLine(row, '20', { held: 'yield', to: 'hourly' }), /hourly took the minute/);
});

test('a held beat is reported as lost, never as retrying', () => {
  // The programme row cannot retry, so a hold must say the beat is gone rather than
  // promise a minute that will not come. A synthetic table proves the wording
  // without weakening the real priority order.
  const outranked = TALK_SLOTS.map(r => (r.kind === 'programme' ? { ...r, priority: 99 } : r));
  const plans = talkTickPlan({
    now: at(20), lastTalkBreakAt: 0, pendingTalk: null,
    eligible: () => true,
    externalSlot: kind => (kind === 'programme' ? 'feature' : null),
    fired: {}, logged: {}, slots: outranked,
  });
  const held = plans.find(p => p.kind === 'programme');
  assert.equal(held?.act, 'wait');
  assert.match(held!.act === 'wait' ? held.log! : '', /^\[programme\] slot feature missed — banter took the minute; and it has no second chance$/);
  assert.equal(canRetry(talkSlot('programme'), 'feature', 20), false);
  assert.equal(canRetry(talkSlot('banter'), '20', 20), true);
  assert.equal(canRetry(talkSlot('banter'), '20', 29), false, 'the last minute of a window is not a retry');
});

test('programme beats are sampled on a 5-minute stride, as their old cron was', () => {
  const asked: number[] = [];
  const r = makeReplay({
    eligible: kind => kind === 'programme',
    externalSlot: (kind, now) => {
      if (kind !== 'programme') return null;
      asked.push(now.getMinutes());
      return 'feature';  // "a beat is due", whatever the station zone says
    },
  });
  r.hour();
  // Every 5th minute and only those: with every real IANA offset a multiple of
  // Every 5th minute and only those: with every real IANA offset a multiple of 15
  // minutes, that lands one tick inside each beat window whatever the zone, as `*/5` did.
  assert.deepEqual(asked, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.deepEqual(r.minutesOf('programme'), asked);
});

test('the programme row carries the beat as its slot, and does not claim it', () => {
  // programme.ts owns beat idempotency in session state, which survives a restart.
  assert.equal(talkSlot('programme').oneFirePerSlot, false);
  const r = makeReplay({
    eligible: kind => kind === 'programme',
    externalSlot: kind => (kind === 'programme' ? 'outro' : null),
  });
  r.tick(at(55));
  r.tick(at(55));  // same minute twice — the row must not remember
  assert.deepEqual(r.rang.map(x => x.slot), ['outro', 'outro']);
  assert.equal(talkSlot('banter').oneFirePerSlot, true);
});

test('policy is asked only for a row that is open and unfired', () => {
  const asked: TalkKind[] = [];
  const r = makeReplay({ eligible: kind => { asked.push(kind); return true; } });
  // :12 falls in no window: the hourly's closed at :09, the ident's opens at :15.
  r.tick(at(12));
  // The jingle rotate is the one row with no window to be outside of — every
  // minute is its own chance (#1619) — so it is the only row a minute in no
  // slot window may reach. The segment director's stride skips :12.
  assert.deepEqual(asked, ['jingle'],
    'the only row a minute inside no slot window may reach is the one with no window');
  // :15 opens the ident row, and a slot row wanting the minute stops the
  // filler's gates being asked at all (see the fill-row tests).
  asked.length = 0;
  r.tick(at(15));
  assert.deepEqual(asked, ['station-id']);
  // The claim is per ROW, not per minute. node-cron fires a minute once, so a
  // repeat tick is only ever the shape of the claim.
  asked.length = 0;
  r.tick(at(15));
  assert.ok(!asked.includes('station-id'), 'a claimed slot is not re-asked');
  assert.deepEqual(r.minutesOf('station-id'), [15], 'and does not air twice');
});

test('the session roll is not in the table', () => {
  // #1500: rollSessionNow() shared the hourly cron and ran BEFORE its gates. It is
  // not a talk row - talkTick awaits it at :00 before consulting the planner.
  assert.deepEqual(TALK_SLOTS.map(r => r.kind).filter(k => (k as string) === 'session-roll'), []);
  const r = makeReplay({ eligible: () => false });
  assert.deepEqual(r.tick(at(0)), []);
});

test('a row that is not due is skipped without a decision', () => {
  const row = talkSlot('banter');
  for (const m of [0, 15, 19, 30, 45, 49]) {
    assert.equal(
      talkSlotPlan(row, {
        now: at(m), lastTalkBreakAt: 0, pendingTalk: null,
        eligible: () => true, externalSlot: () => null, fired: {}, logged: {},
      }),
      null,
      `:${m} must not reach the gap check`,
    );
  }
});


// TALK ONLY BETWEEN TRACKS (#1485 FR 5b). `djTalkOnlyBetweenTracks`, resolved by
// broadcast/talk-air.ts and handed to the planner as `betweenTracksOnly`, forces
// every row onto the next track boundary. Off is the old station exactly. The one
// deferred slot holds a single segment, so a row firing while a clip waits would
// delete a rendered segment: the hold widens to rows with `minGapMs: 0` too.

test('the switch is off by default, and the table keeps its per-row air modes', () => {
  // The off case is the upgrade promise. The planner default and an explicit false
  // are the same thing, and both report the row's own mode.
  for (const betweenTracksOnly of [undefined, false]) {
    const r = makeReplay({ betweenTracksOnly, eligible: () => true, externalSlot: () => null });
    r.hour();
    const airOf = (k: TalkKind) => r.rang.filter(x => x.kind === k).map(x => x.air);
    assert.deepEqual(airOf('station-id'), ['next-track', 'next-track', 'next-track']);
    assert.deepEqual(airOf('hourly'), ['immediate']);
    assert.deepEqual(airOf('banter'), ['immediate', 'immediate']);
    assert.ok(airOf('segment').every(a => a === 'immediate'), 'the filler airs immediately too');
  }
});

test('the switch forces every row onto the next track boundary, the fill row included', async () => {
  // Including the two rows it is tempting to exempt: the hourly check reads a clock,
  // and the segment director has no slot to protect.
  await station('aggressive');
  const r = makeReplay({
    betweenTracksOnly: true,
    eligible: () => true,
    // One beat, where a real `dueBeat` window puts it.
    externalSlot: (kind, now) => (kind === 'programme' && now.getMinutes() === 35 ? 'feature' : null),
  });
  r.hour();
  assert.ok(r.rang.length >= 6, 'the hour still talks');
  assert.deepEqual([...new Set(r.rang.map(x => x.air))], ['next-track']);
  // Every KIND, not just every fire.
  for (const kind of ['hourly', 'banter', 'station-id', 'segment', 'programme'] as TalkKind[]) {
    assert.ok(r.rang.some(x => x.kind === kind), `${kind} never fired — the assertion above proves nothing about it`);
  }
});

test('with the switch on, a waiting clip holds even the rows that take no gap', () => {
  // `minGapMs: 0` means the row does not ask whether the listener has had quiet. It
  // has never meant it may overwrite a rendered segment, which firing would do here.
  const pendingTalk = { kind: 'hourly-check', queuedAt: clockAt(38) };
  for (const kind of ['programme', 'segment'] as TalkKind[]) {
    assert.equal(talkSlot(kind).minGapMs, 0, `${kind} must be a no-gap row for this test to mean anything`);
    const off = makeReplay({
      pendingTalk, eligible: k => k === kind,
      externalSlot: k => (k === 'programme' ? 'feature' : null),
    });
    off.tick(at(40));
    assert.deepEqual(off.minutesOf(kind), [40], `${kind}: unchanged with the switch off`);

    const on = makeReplay({
      betweenTracksOnly: true, pendingTalk, eligible: k => k === kind,
      externalSlot: k => (k === 'programme' ? 'feature' : null),
    });
    on.tick(at(40));
    assert.deepEqual(on.minutesOf(kind), [], `${kind}: the boundary is taken`);
  }
});

test('the hold is a postpone: the clip airs, and the held row takes the next minute in its window', () => {
  // The release, which is what makes this a postpone. The ident airs at :03 and the
  // hourly check, held since :00, speaks at :04, still inside its own window.
  const r = makeReplay({
    betweenTracksOnly: true,
    pendingTalk: now => (now.getMinutes() < 4 ? { kind: 'station-id', queuedAt: clockAt(58, 0, HOUR - 1) } : null),
    eligible: kind => kind === 'hourly',
  });
  for (let m = 0; m <= 9; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('hourly'), [4]);
  assert.equal(r.logs.length, 1, 'held once, then took the minute');
  assert.match(r.logs[0], /^\[hourly\] stood down at :0 — a station-id is rendered and waiting for the next track boundary \(retrying until :9\)$/);
});

test('a clip whose queue life runs out stops holding, without waiting for a boundary', () => {
  // A clip past PENDING_VOICE_MAX_AGE_MS can no longer take the boundary. Queued at
  // :45 of the previous hour, it expires exactly at :05.
  const r = makeReplay({
    betweenTracksOnly: true,
    pendingTalk: { kind: 'station-id', queuedAt: clockAt(45, 0, HOUR - 1) },
    eligible: kind => kind === 'hourly',
  });
  for (let m = 0; m <= 9; m++) r.tick(at(m));
  assert.equal(clockAt(45, 0, HOUR - 1) + PENDING_VOICE_MAX_AGE_MS, clockAt(5), 'fixture: expiry lands on :05');
  assert.deepEqual(r.minutesOf('hourly'), [5]);
});

test('the last-minute release is NOT taken when the switch is on — it would delete the waiting clip', () => {
  // The one rule that inverts. With the switch off the window's final minute is
  // never given away (#1539). With it on the row would defer too, and the single
  // slot holds one segment, so firing would replace a rendered, paid-for segment.
  // Missing the window is then the honest outcome, and it logs as a miss.
  const queuedAt = clockAt(51, 0, HOUR - 1);  // valid to :11, past the hourly window's :09 close
  const off = makeReplay({ pendingTalk: { kind: 'station-id', queuedAt }, eligible: k => k === 'hourly' });
  for (let m = 0; m <= 9; m++) off.tick(at(m));
  assert.deepEqual(off.minutesOf('hourly'), [9], 'off: the final chance is never given away');

  const on = makeReplay({
    betweenTracksOnly: true, pendingTalk: { kind: 'station-id', queuedAt }, eligible: k => k === 'hourly',
  });
  for (let m = 0; m <= 9; m++) on.tick(at(m));
  assert.deepEqual(on.minutesOf('hourly'), [], 'on: the clip keeps the boundary');
  assert.equal(on.logs.length, 2, 'one stand-down, then one miss when the window closes');
  assert.match(on.logs[0], /^\[hourly\] stood down at :0 —/);
  assert.match(
    on.logs[1],
    /^\[hourly\] slot :0 missed — a station-id is rendered and waiting for the next track boundary; window closed at :9$/,
  );
});

test('a programme beat held by a waiting clip is reported as lost, not as retrying', () => {
  // The beat row samples `dueBeat` once, so a beat that cannot take its minute has
  // no second chance; the log must say so rather than promise a retry.
  const r = makeReplay({
    betweenTracksOnly: true,
    pendingTalk: { kind: 'station-id', queuedAt: clockAt(33) },
    eligible: kind => kind === 'programme',
    externalSlot: kind => (kind === 'programme' ? 'feature' : null),
  });
  r.tick(at(35));
  assert.deepEqual(r.minutesOf('programme'), []);
  assert.match(
    r.logs[0],
    /^\[programme\] slot feature missed — a station-id is rendered and waiting for the next track boundary; and it has no second chance$/,
  );
});

test('one talker per minute survives the switch — the loser waits, it does not also defer', () => {
  // Arbitration runs before placement: banter outranks the ident at :20, takes the
  // minute, and the ident waits inside its own window exactly as with the switch off.
  const r = makeReplay({
    betweenTracksOnly: true,
    lastTalkBreakAt: clockAt(0),
    eligible: kind => kind === 'banter' || kind === 'station-id',
  });
  r.tick(at(20));
  assert.deepEqual(r.rang.map(x => `${x.kind}@${x.minute}`), ['banter@20']);
  assert.match(r.logs[0], /^\[station-id\] stood down at :15 — banter took the minute \(retrying until :24\)$/);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
