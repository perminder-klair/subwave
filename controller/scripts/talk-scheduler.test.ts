// Pins the TALK SLOT TABLE (broadcast/talk-scheduler.ts) — #1500, PR 1.
//
// Four crons became one per-minute tick over a table. The whole claim of that
// PR is that it is BEHAVIOUR-PRESERVING, and per the repo's own rule a
// refactor that says so has to prove it. So the load-bearing test here is the
// first one: an independent model of the OLD schedule — the four cron
// expressions and the frequency rungs, written out by hand — replayed against
// the real planner, minute by minute, for every rung. If the table ever fires
// on a minute the old crons didn't (or stops firing on one they did), that test
// says which minute and which kind.
//
// The rest pin the properties the table is supposed to carry forward:
//
//  - The fixed windows stay DISJOINT. Two rows opening on one minute is #310
//    (a station ID and an hourly check stacked back to back), which the old
//    code prevented by hand-partitioning minutes across four cron strings.
//  - Banter's window survives the generalisation intact (#1419): the tail, the
//    slot identity of a retry minute, the 5-minute gap, one fire per slot, the
//    logged-once stand-down. These assertions moved here verbatim from
//    scripts/banter-policy.test.ts along with the machinery they cover.
//  - The rows that DON'T have a gap still don't. `minGapMs: 0` has to read as
//    "no check", not as "a check that usually passes" — an ident 25s after a
//    talk break fires today and must keep firing, or PR 1 has quietly shipped
//    PR 2's behaviour change.
//  - Per-row `air` and `clock` survive. Idents defer to the next track
//    boundary; programme beats are a station-clock fact sampled on a 5-minute
//    stride. Both are properties the scheduler may not unify away.
//  - Nothing is asked before it is due. The planner resolves eligibility and
//    external slots lazily, so a closed window never reaches a policy module —
//    which is what keeps the gates evaluated exactly where they were.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import so
// settings.load()/update() touch nothing real — hence the dynamic imports. Same
// shape as scripts/banter-policy.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Types only — erased at build time, so this does not import the module before
// STATE_DIR is redirected below.
import type { TalkKind, TalkPlan } from '../src/broadcast/talk-scheduler.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-talk-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const {
  TALK_SLOTS, talkSlot, talkTickPlan, talkSlotPlan, talkGap, talkSlotKey,
  openMinuteFor, windowEndMinute, standDownLine, missedLine,
} = await import('../src/broadcast/talk-scheduler.js');
const { BANTER_SLOTS, BANTER_WINDOW_MINUTES, BANTER_MIN_GAP_MS } = await import('../src/broadcast/banter-policy.js');
const { shouldFire } = await import('../src/broadcast/dj-gate.js');
const { zonedParts } = await import('../src/time.js');

// The default roster's first persona, re-fadered to the frequency under test.
// Patching the seeded persona (rather than writing one from scratch) keeps the
// strict TTS/soul validators happy; same trick as scripts/clock-policy.test.ts.
async function station(frequency: string) {
  await settings.update({
    tts: { enabled: true },
    personas: settings.get().personas.map((p: any, i: number) =>
      (i === 0 ? { ...p, frequency, djMode: false } : p)),
  } as any);
}

const at = (minute: number, hour = 9) => new Date(2026, 7, 19, hour, minute, 0);

// ---------------------------------------------------------------------------
// THE OLD SCHEDULE, MODELLED INDEPENDENTLY
// Written from the cron expressions and the rungs as they stood before #1500,
// NOT from the table — the point is for the two to be able to disagree.
//   hourlyCheck   '0 * * * *'         + shouldFire('hourly')   (quiet: even station hours)
//   stationId     '15,30,45 * * * *'  + shouldFire('stationId') (quiet: :45, moderate: :15/:45)
//   banterTick    '20-29,50-59 * * * *' + the window state machine
//   programmeTick '*/5 * * * *'       + programme.dueBeat()
// ---------------------------------------------------------------------------

function oldIdentMinutes(frequency: string): number[] {
  if (frequency === 'quiet') return [45];
  if (frequency === 'moderate') return [15, 45];
  return [15, 30, 45];
}

function oldBanterSlots(frequency: string): number[] {
  if (frequency === 'quiet') return [];
  if (frequency === 'moderate') return [20];
  return [20, 50];
}

// One tick's worth of driving, threading the two slot maps back in exactly as
// scheduler.talkTick does.
function makeReplay(opts: {
  lastTalkBreakAt?: number;
  eligible?: (kind: TalkKind, now: Date) => boolean;
  externalSlot?: (kind: TalkKind, now: Date) => string | null;
} = {}) {
  const fired: Partial<Record<TalkKind, string | null>> = {};
  const logged: Partial<Record<TalkKind, string | null>> = {};
  const rang: { minute: number; kind: TalkKind; slot: string }[] = [];
  const logs: string[] = [];
  const tick = (now: Date) => {
    const plans: TalkPlan[] = talkTickPlan({
      now,
      lastTalkBreakAt: opts.lastTalkBreakAt ?? 0,
      eligible: kind => (opts.eligible ? opts.eligible(kind, now) : true),
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
      rang.push({ minute: now.getMinutes(), kind: plan.kind, slot: plan.slot });
    }
    return plans;
  };
  return { tick, rang, logs };
}

// ---------------------------------------------------------------------------

test('the table fires on exactly the minutes the four crons fired on', async () => {
  for (const frequency of ['quiet', 'moderate', 'chatty', 'aggressive']) {
    await station(frequency);
    // Two hours, so the `quiet` rung's every-other-STATION-hour time check is
    // actually exercised rather than assumed.
    for (const hour of [9, 10]) {
      // Gates that were constant-true for a live station in the old crons stay
      // constant-true here; the ones that shaped the SCHEDULE (the frequency
      // ladder) are resolved through the real dj-gate, not stubbed.
      const { tick, rang } = makeReplay({
        eligible: (kind, now) => {
          if (kind === 'programme') return false;  // covered on its own below
          if (kind === 'station-id') return shouldFire('stationId', now);
          return shouldFire(kind, now);
        },
      });
      for (let m = 0; m < 60; m++) tick(at(m, hour));

      const hourly = rang.filter(r => r.kind === 'hourly').map(r => r.minute);
      const expectHourly = (frequency !== 'quiet' || zonedParts(at(0, hour)).hour % 2 === 0) ? [0] : [];
      assert.deepEqual(hourly, expectHourly, `${frequency} @${hour}: hourly minutes`);

      const idents = rang.filter(r => r.kind === 'station-id').map(r => r.minute);
      assert.deepEqual(idents, oldIdentMinutes(frequency), `${frequency} @${hour}: ident minutes`);

      // Nothing has aired in this replay, so the gap is open from the minute
      // each window opens — which is where the old fixed `20,50` cron fired.
      const banter = rang.filter(r => r.kind === 'banter').map(r => r.minute);
      assert.deepEqual(banter, oldBanterSlots(frequency), `${frequency} @${hour}: banter minutes`);
    }
  }
});

test('no minute opens two fixed windows — the #310 partition survives as a property', () => {
  const fixed = TALK_SLOTS.filter(r => r.opens !== 'external');
  for (let m = 0; m < 60; m++) {
    const open = fixed.filter(r => openMinuteFor(r, m) != null).map(r => r.kind);
    assert.ok(open.length <= 1, `:${m} opens ${open.join(' + ')} — two scheduled talkers on one minute`);
  }
  // The specific pair the issue is about: the hourly check owns :00 and the
  // ident row must never reach it, whatever its window grows to.
  assert.equal(openMinuteFor(talkSlot('station-id'), 0), null);
  // And banter's window must not reach the next ident slot at :30 (it opens at
  // :20 and runs to :29) — the assertion that used to read banterWindowEnd.
  assert.equal(windowEndMinute(talkSlot('banter'), 20), 29);
  assert.equal(openMinuteFor(talkSlot('banter'), 30), null);
});

test('per-row air mode and clock survive the merge', () => {
  // An ident defers to the next track boundary; everything else airs
  // immediately through the voice queue. Unifying these is the bug.
  assert.equal(talkSlot('station-id').air, 'next-track');
  for (const kind of ['hourly', 'banter', 'programme'] as TalkKind[]) {
    assert.equal(talkSlot(kind).air, 'immediate', `${kind} must air immediately`);
  }
  // Two clocks coexist deliberately: slot minutes are process time (they have
  // to agree with when the cron fires), programme beats are a station-zone fact.
  assert.equal(talkSlot('programme').clock, 'station');
  for (const kind of ['hourly', 'banter', 'station-id'] as TalkKind[]) {
    assert.equal(talkSlot(kind).clock, 'process', `${kind} slots are process minutes`);
  }
});

test('PR 1 windows are single minutes and PR 1 gaps are zero, except banter', () => {
  // The values that make this refactor behaviour-identical. Widening them is
  // PR 2 and has to be a stated behaviour change — if this test starts failing
  // without that PR, the schedule moved by accident.
  for (const kind of ['hourly', 'station-id'] as TalkKind[]) {
    assert.equal(talkSlot(kind).windowMinutes, 1, `${kind} has no retry window yet`);
    assert.equal(talkSlot(kind).minGapMs, 0, `${kind} has no quiet gap yet`);
  }
  assert.equal(talkSlot('banter').windowMinutes, BANTER_WINDOW_MINUTES);
  assert.equal(talkSlot('banter').minGapMs, BANTER_MIN_GAP_MS);
  assert.deepEqual([...talkSlot('banter').opens as readonly number[]], [...BANTER_SLOTS]);
});

test('a zero gap is no check at all — an ident still fires 25s after a talk break', () => {
  // The tempting accident in this refactor: generalising banter's gap onto
  // every row. An ident that lands 25s behind a segment is today's behaviour,
  // and PR 1 must not change it (PR 2 may, deliberately).
  const now = at(15);
  const { tick, rang, logs } = makeReplay({ lastTalkBreakAt: now.getTime() - 25_000 });
  tick(now);
  assert.deepEqual(rang.map(r => r.kind), ['station-id']);
  assert.deepEqual(logs, [], 'a row with no gap has nothing to stand down about');
  // Same for the hourly check at :00.
  const top = at(0);
  const hourly = makeReplay({ lastTalkBreakAt: top.getTime() - 25_000 });
  hourly.tick(top);
  assert.deepEqual(hourly.rang.map(r => r.kind), ['hourly']);
});

// ---------------------------------------------------------------------------
// BANTER'S WINDOW, THROUGH THE GENERALISED PLANNER
// Moved from scripts/banter-policy.test.ts with the machinery. #1419 is the
// only bug the old scheduler had a real fix for, so the new planner has to
// reproduce it exactly rather than approximately.
// ---------------------------------------------------------------------------

const WINDOW_20 = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29];

function replayBanter(minutes: number[], opts: { talkAtMin?: number; talkAtSec?: number; eligible?: boolean } = {}) {
  const lastTalkBreakAt = opts.talkAtMin == null
    ? 0
    : new Date(2026, 7, 19, 9, opts.talkAtMin, opts.talkAtSec ?? 0).getTime();
  const r = makeReplay({
    lastTalkBreakAt,
    eligible: kind => kind === 'banter' && (opts.eligible ?? true),
  });
  for (const m of minutes) r.tick(at(m));
  return { fired: r.rang.map(x => x.minute), logs: r.logs };
}

test("the reporter's hour: a :19:35 ident postpones the exchange, it no longer cancels it", () => {
  // 09:15 ident → boundary-deferred → actually airs 09:19:35. The pre-#1419
  // code saw 25s at the :20 tick and gave up until :50 (or, on moderate, until
  // 10:20).
  const { fired, logs } = replayBanter(WINDOW_20, { talkAtMin: 19, talkAtSec: 35 });
  // The gap clears at :24:35, so :24 is still short (24:00 − 19:35 = 265s) and
  // :25 is the first minute that may air.
  assert.deepEqual(fired, [25]);
  // One stand-down line for the slot, not one per blocked minute.
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[banter\] stood down at :20 — last standalone talk 25s ago/);
  assert.match(logs[0], /minimum gap 300s \(retrying until :29\)/);
});

test('a slot fires at most once, however many minutes are left in the window', () => {
  const { fired, logs } = replayBanter(WINDOW_20);
  assert.deepEqual(fired, [20], 'the slot opens, airs once, and stays quiet');
  assert.deepEqual(logs, []);
  // The :50 window is its own chance, unaffected by the :20 one.
  assert.deepEqual(replayBanter([...WINDOW_20, 50, 51, 52]).fired, [20, 50]);
});

test('a window that never clears says so once, at the minute it is lost', () => {
  const late = replayBanter(WINDOW_20, { talkAtMin: 24, talkAtSec: 30 });
  assert.deepEqual(late.fired, [], 'the gap never clears inside this window');
  assert.equal(late.logs.length, 2, 'one stand-down at :20, one "missed" at :29');
  assert.match(late.logs[0], /stood down at :20/);
  assert.match(late.logs[1], /slot :20 missed/);
  // The last minute being the FIRST blocked one still reports, with numbers —
  // the case where an operator would otherwise get no line at all.
  const only29 = replayBanter([29], { talkAtMin: 28, talkAtSec: 30 });
  assert.deepEqual(only29.fired, []);
  assert.equal(only29.logs.length, 1);
  assert.match(only29.logs[0], /slot :20 missed — last standalone talk 30s ago/);
});

test('an ineligible row is silent — it never logs about a gap it never reached', () => {
  const out = replayBanter(WINDOW_20, { talkAtMin: 19, talkAtSec: 35, eligible: false });
  assert.deepEqual(out.fired, []);
  assert.deepEqual(out.logs, [], 'a per-minute tick must not narrate ineligible minutes');
});

test('a retry minute keeps its slot identity, so one window is one chance', () => {
  const row = talkSlot('banter');
  for (const slot of BANTER_SLOTS) {
    for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
      assert.equal(openMinuteFor(row, slot + i), slot, `:${slot + i} should belong to slot :${slot}`);
    }
  }
  // Stable across the window, distinct across slots, hours and days — what
  // makes "one fire per slot" survive a per-minute tick without a countdown.
  const opening = talkSlotKey('banter', at(20), '20');
  for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
    assert.equal(talkSlotKey('banter', at(20 + i), '20'), opening);
  }
  assert.notEqual(talkSlotKey('banter', at(50), '50'), opening);
  assert.notEqual(talkSlotKey('banter', at(20, 10), '20'), opening);
  assert.notEqual(talkSlotKey('banter', new Date(2026, 7, 20, 9, 20, 0), '20'), opening);
  // …and distinct across KINDS, which the old single-row key didn't have to be.
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

test('the stand-down lines carry the reason and the numbers', () => {
  const row = talkSlot('banter');
  const now = 1_000_000_000_000;
  const gap = talkGap({ nowMs: now, lastTalkBreakAt: now - 25_000, needMs: BANTER_MIN_GAP_MS });
  const line = standDownLine(row, '20', gap);
  // Which gap, how long ago, how long is left — and which row said so, which
  // matters now that four kinds share one log channel.
  assert.match(line, /^\[banter\]/);
  assert.match(line, /25s ago/);
  assert.match(line, /300s/);
  assert.match(line, /:29/);
  const missed = missedLine(row, '20', gap);
  assert.match(missed, /slot :20 missed/);
  assert.match(missed, /25s ago/);
  assert.match(missed, /300s/);
  // A fresh boot has no last break — the line must not print "Infinitys".
  assert.match(standDownLine(row, '20', talkGap({ nowMs: now, lastTalkBreakAt: 0, needMs: 1 })), /never ago/);
});

// ---------------------------------------------------------------------------
// THE PROGRAMME ROW
// ---------------------------------------------------------------------------

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
  for (let m = 0; m < 60; m++) r.tick(at(m));
  // Every 5th minute and only those: with every real IANA offset a multiple of
  // 15 minutes, that lands exactly one tick inside each beat window (:35–:39,
  // :55+) whatever the zone — which is what `*/5` did. A per-minute row would
  // add retries the old cron never had, and that is PR 2's call to make.
  assert.deepEqual(asked, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.deepEqual(r.rang.filter(x => x.kind === 'programme').map(x => x.minute), asked);
});

test('the programme row carries the beat as its slot, and does not claim it', () => {
  // programme.ts owns beat idempotency in session state (which survives a
  // restart); a second in-memory claim here could only suppress a fire the old
  // cron would have made.
  assert.equal(talkSlot('programme').oneFirePerSlot, false);
  const r = makeReplay({
    eligible: kind => kind === 'programme',
    externalSlot: kind => (kind === 'programme' ? 'outro' : null),
  });
  r.tick(at(55));
  r.tick(at(55));  // same minute twice — the row must not remember
  assert.deepEqual(r.rang.map(x => x.slot), ['outro', 'outro']);
  // A row that DOES claim behaves the other way, on the same replay shape.
  assert.equal(talkSlot('banter').oneFirePerSlot, true);
});

test('a programme beat and a banter window can come due together, in table order', () => {
  // The only pair that can: the fixed windows are disjoint, but a station zone
  // at a :30/:45 offset puts a station-clock beat inside a process-minute
  // banter window. Both used to fire from separate crons; now they dispatch in
  // one tick, and the table is where the order is written down.
  const r = makeReplay({
    eligible: () => true,
    externalSlot: kind => (kind === 'programme' ? 'outro' : null),
  });
  const plans = r.tick(at(25));
  assert.deepEqual(plans.map(p => p.kind), ['programme', 'banter']);
  assert.ok(talkSlot('programme').priority <= talkSlot('banter').priority);
});

// ---------------------------------------------------------------------------
// LAZINESS — what the planner is allowed to ask, and when
// ---------------------------------------------------------------------------

test('policy is asked only for a row that is open and unfired', () => {
  const asked: TalkKind[] = [];
  const r = makeReplay({
    eligible: kind => { asked.push(kind); return true; },
  });
  // :07 opens nothing at all.
  r.tick(at(7));
  assert.deepEqual(asked, [], 'a closed window must not reach a policy module');
  // :15 opens the ident row and nothing else.
  r.tick(at(15));
  assert.deepEqual(asked, ['station-id']);
  // Second tick on the same minute: the slot is claimed, so the gates are not
  // re-asked (and the segment is not re-aired).
  asked.length = 0;
  r.tick(at(15));
  assert.deepEqual(asked, []);
  assert.equal(r.rang.length, 1);
});

test('the session roll is not in the table', () => {
  // #1500 finding 3: rollSessionNow() shared the hourly cron and ran BEFORE its
  // gates, so a muted, empty or over-budget station still rolled its session,
  // planned the episode and left the handoff pending. It is therefore not a
  // talk row — scheduler.talkTick awaits it at :00 before consulting the
  // planner at all, and this is what that looks like from here: with every gate
  // shut, :00 plans nothing, and the roll has already happened anyway.
  assert.deepEqual(TALK_SLOTS.map(r => r.kind).filter(k => (k as string) === 'session-roll'), []);
  const r = makeReplay({ eligible: () => false });
  assert.deepEqual(r.tick(at(0)), []);
});

test('a row that is not due is skipped without a decision', () => {
  const row = talkSlot('banter');
  for (const m of [0, 15, 19, 30, 45, 49]) {
    assert.equal(
      talkSlotPlan(row, {
        now: at(m), lastTalkBreakAt: 0, eligible: () => true, externalSlot: () => null,
        fired: {}, logged: {},
      }),
      null,
      `:${m} must not reach the gap check`,
    );
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
