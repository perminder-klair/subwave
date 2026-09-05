// Pins the TALK SLOT TABLE and its arbitration (broadcast/talk-scheduler.ts) —
// #1500, PRs 1 and 2.
//
// PR 1 merged four talk crons into one per-minute tick over a table, with
// windows of one minute and no gaps, so the schedule was byte-identical. PR 2
// turns the table on: real windows, real quiet gaps, one talker per minute, and
// a stand-down line whatever the reason. That is a deliberate behaviour change,
// so the tests carry the shape of the change rather than a reproduction of the
// old schedule.
//
// The properties, and the real way each regresses:
//
//  - A QUIET HOUR IS UNCHANGED. Widening a window must cost nothing when
//    nothing is in the way: every row still fires on the minute its old cron
//    did. If this drifts, the windows have started moving the schedule instead
//    of rescuing it.
//  - POSTPONE, NEVER CANCEL. #1419's fix, generalised. A row that loses its
//    opening minute — to a talk break, to a rendered ident waiting on a
//    boundary, or to another row — retries inside its window rather than
//    vanishing until the next slot (or, on `quiet`, the next hour).
//  - ONE TALKER PER MINUTE (#310). Windows now OVERLAP by design, so this can
//    no longer be a property of the cron strings; it has to be a property of
//    the planner, and nothing else enforces it.
//  - A ROW YIELDS ONLY TO A ROW THAT IS FIRING. Yielding to a merely-open
//    higher-priority row would let one row sit on its whole window holding
//    everything under it — #1419 again, one layer up. This is the subtle one.
//  - IN-FLIGHT TALK COUNTS, BUT NEVER PAST THE ROW'S LAST CHANCE. A boundary-
//    deferred ident is queued minutes before it airs and `getLastTalkBreakAt()`
//    cannot see it, which is how a :20 tick read a clear gap and still landed
//    ten seconds in front of it. The hold is bounded at both ends: a clip that
//    expires inside the window never blocks, and one that outlives the window
//    stops blocking on the window's last retry minute, so a held row still
//    fires inside its window instead of logging `missed` (#1539).
//  - The frequency ladder answers per SLOT. `[15,30,45].includes(m)` reads a
//    retry minute as no slot at all, which would silently cancel every retry
//    the windows exist to allow.
//  - A FILL ROW IS NOT A SLOT ROW. The segment director has no wall-clock
//    placement, so it stands down whenever a scheduled row wants the minute —
//    including one that is merely waiting, since a filler that speaks now
//    resets the quiet gap and pushes that row's retry out. It is the one row
//    exempt from the yield-only-to-a-firing-row rule, and it is exempt for the
//    same reason the rule exists: it cannot be starved by yielding.
//  - Per-row `air` and `clock` survive, and nothing is asked before it is due.
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
  openMinuteFor, windowEndMinute, canRetry, standDownLine, missedLine,
} = await import('../src/broadcast/talk-scheduler.js');
const { BANTER_SLOTS, BANTER_WINDOW_MINUTES, BANTER_MIN_GAP_MS } = await import('../src/broadcast/banter-policy.js');
const { PENDING_VOICE_MAX_AGE_MS } = await import('../src/broadcast/queue/kinds.js');
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

const HOUR = 9;
const at = (minute: number, hour = HOUR) => new Date(2026, 7, 19, hour, minute, 0);
const clockAt = (minute: number, second = 0, hour = HOUR) =>
  new Date(2026, 7, 19, hour, minute, second).getTime();

// Drives the planner exactly as scheduler.talkTick does, threading the two slot
// maps back in. `feedback` closes the loop the real station closes: a segment
// that airs sets the quiet gap for every row after it, which is what makes a
// disrupted hour testable at all.
function makeReplay(opts: {
  lastTalkBreakAt?: number;
  feedback?: boolean;
  pendingTalk?: { kind: string; queuedAt: number } | null;
  eligible?: (kind: TalkKind, now: Date) => boolean;
  externalSlot?: (kind: TalkKind, now: Date) => string | null;
} = {}) {
  const fired: Partial<Record<TalkKind, string | null>> = {};
  const logged: Partial<Record<TalkKind, string | null>> = {};
  const rang: { minute: number; kind: TalkKind; slot: string }[] = [];
  const logs: string[] = [];
  let lastTalkBreakAt = opts.lastTalkBreakAt ?? 0;
  const tick = (now: Date) => {
    const plans: TalkPlan[] = talkTickPlan({
      now,
      lastTalkBreakAt,
      pendingTalk: opts.pendingTalk ?? null,
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
      if (opts.feedback) lastTalkBreakAt = now.getTime();
    }
    return plans;
  };
  const hour = (hourOf = HOUR) => { for (let m = 0; m < 60; m++) tick(at(m, hourOf)); };
  return { tick, hour, rang, logs, minutesOf: (k: TalkKind) => rang.filter(r => r.kind === k).map(r => r.minute) };
}

// ---------------------------------------------------------------------------
// THE SCHEDULE
// ---------------------------------------------------------------------------

test('a quiet hour is unchanged — every row still fires on the minute its cron did', async () => {
  // The four expressions the table replaced, and the rungs that narrowed them:
  //   hourlyCheck   '0 * * * *'          quiet: even station hours only
  //   stationId     '15,30,45 * * * *'   quiet: :45, moderate: :15/:45
  //   banterTick    '20,50 * * * *'      quiet: never, moderate: :20 only
  // Widening the windows and adding the gaps must not move any of them when the
  // hour has room. Talk FEEDS BACK here, so each segment that airs sets the gap
  // for the next — an hour of real spacing, not an artificially empty one.
  const identMinutes = (f: string) => (f === 'quiet' ? [45] : f === 'moderate' ? [15, 45] : [15, 30, 45]);
  const banterMinutes = (f: string) => (f === 'quiet' ? [] : f === 'moderate' ? [20] : [20, 50]);

  for (const frequency of ['quiet', 'moderate', 'chatty', 'aggressive']) {
    await station(frequency);
    // Two hours, so the `quiet` rung's every-other-STATION-hour time check is
    // actually exercised rather than assumed.
    for (const hour of [9, 10]) {
      const r = makeReplay({
        feedback: true,
        eligible: (kind, now) => {
          if (kind === 'programme') return false;  // covered on its own below
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
  // The windows OVERLAP now (an ident's :15 window reaches into banter's :20
  // one), so #310 can no longer be read off the cron strings. What survives at
  // the table level is that no two rows OPEN together: every collision is a new
  // chance meeting another row's tail, which is what arbitration resolves.
  const opens = new Map<number, TalkKind>();
  for (const row of TALK_SLOTS) {
    if (row.opens === 'external') continue;
    for (const m of row.opens) {
      assert.equal(opens.get(m), undefined, `:${m} opens both ${opens.get(m)} and ${row.kind}`);
      opens.set(m, row.kind);
    }
  }
  // The specific pair the issue is about: the hourly check owns :00, and the
  // ident row must not open there whatever its window grows to.
  assert.equal(openMinuteFor(talkSlot('station-id'), 0), null);
  // And the overlap that now exists on purpose, so the arbitration tests below
  // are testing a real minute rather than a hypothetical one.
  assert.equal(openMinuteFor(talkSlot('station-id'), 20), 15);
  assert.equal(openMinuteFor(talkSlot('banter'), 20), 20);
});

test('the table carries real windows and real gaps, banter widest', () => {
  // Banter is the longest break the station airs, so it holds out for the most
  // quiet; the short segments settle for three minutes, which is still enough
  // to stop one landing on the back of another (#310, as a number).
  assert.equal(talkSlot('banter').minGapMs, BANTER_MIN_GAP_MS);
  assert.equal(talkSlot('banter').windowMinutes, BANTER_WINDOW_MINUTES);
  for (const kind of ['hourly', 'station-id'] as TalkKind[]) {
    assert.ok(talkSlot(kind).windowMinutes > 1, `${kind} must be able to retry`);
    assert.ok(talkSlot(kind).minGapMs > 0, `${kind} must respect a quiet gap`);
    assert.ok(talkSlot(kind).minGapMs < BANTER_MIN_GAP_MS, `${kind} should be less demanding than banter`);
  }
  // The programme beat is the exception at both ends: it cannot retry, so it
  // leads the priority order and takes no gap — the beats ARE the show.
  assert.equal(talkSlot('programme').minGapMs, 0);
  assert.equal(Math.min(...TALK_SLOTS.map(r => r.priority)), talkSlot('programme').priority);
  // The ordering principle: fewer chances in the hour outranks more.
  assert.ok(talkSlot('hourly').priority < talkSlot('banter').priority);
  assert.ok(talkSlot('banter').priority < talkSlot('station-id').priority);
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

// ---------------------------------------------------------------------------
// POSTPONE, NEVER CANCEL
// ---------------------------------------------------------------------------

test('a disrupted hour postpones every row instead of dropping it', async () => {
  await station('aggressive');
  // A segment-director spot lands at :14:00 — off-clock, exactly the kind of
  // thing the old fixed minutes could not see. Under the old crons the :15
  // ident fired straight into its back (#310's failure, arriving off-schedule
  // rather than on it); now it waits out its three minutes and takes :17.
  const r = makeReplay({
    lastTalkBreakAt: clockAt(14),
    feedback: true,
    eligible: (kind, now) => kind !== 'programme' && shouldFire(kind === 'station-id' ? 'stationId' : kind, now),
  });
  for (let m = 15; m < 30; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('station-id'), [17], 'the ident postpones to the first clear minute');
  // …and banter, which needs five clear minutes, takes :22 rather than losing
  // the slot the way it did before #1419.
  assert.deepEqual(r.minutesOf('banter'), [22]);
  // One line per held slot, naming the cause and the numbers.
  assert.equal(r.logs.length, 2);
  assert.match(r.logs[0], /^\[station-id\] stood down at :15 — last standalone talk 60s ago, minimum gap 180s \(retrying until :24\)$/);
  assert.match(r.logs[1], /^\[banter\] stood down at :20 — last standalone talk \d+s ago, minimum gap 300s \(retrying until :29\)$/);
});

test("the reporter's hour: a :19:35 ident postpones the exchange, it no longer cancels it", () => {
  // The #1419 case itself. A :15 ident is boundary-deferred and actually airs
  // at 09:19:35; the pre-fix code saw 25s at the :20 tick and gave up until
  // :50 (or, on moderate, until 10:20).
  const r = makeReplay({
    lastTalkBreakAt: clockAt(19, 35),
    eligible: kind => kind === 'banter',
  });
  for (let m = 20; m <= 29; m++) r.tick(at(m));
  // The gap clears at :24:35, so :24 is still short (24:00 − 19:35 = 265s) and
  // :25 is the first minute that may air.
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
  // The last minute being the FIRST blocked one still reports, with numbers —
  // the case where an operator would otherwise get no line at all.
  const only = makeReplay({ lastTalkBreakAt: clockAt(28, 30), eligible: kind => kind === 'banter' });
  only.tick(at(29));
  assert.deepEqual(only.minutesOf('banter'), []);
  assert.equal(only.logs.length, 1);
  assert.match(only.logs[0], /slot :20 missed — last standalone talk 30s ago/);
});

test('every row logs its stand-down now, not just banter', () => {
  // The half of #1419's fix that only banter got: an ident or an hourly check
  // that stood down used to be a bare `return`, so a starved hour left nothing
  // in the booth log to explain itself.
  for (const [kind, open] of [['hourly', 0], ['station-id', 15], ['banter', 20]] as const) {
    const r = makeReplay({ lastTalkBreakAt: clockAt(open, 0), eligible: k => k === kind });
    r.tick(at(open + 1));
    assert.equal(r.logs.length, 1, `${kind} must report standing down`);
    assert.match(r.logs[0], new RegExp(`^\\[${kind}\\] stood down at :${open} — last standalone talk 60s ago`));
  }
});

// ---------------------------------------------------------------------------
// ONE TALKER PER MINUTE
// ---------------------------------------------------------------------------

test('when two rows would both fire, priority takes the minute and the loser waits', () => {
  // :20 is the overlap the wider ident window creates: banter's :20 chance
  // opens while the ident's :15 window still has four minutes to run. Both are
  // clear, so this is arbitration and nothing else.
  const r = makeReplay({ eligible: kind => kind === 'banter' || kind === 'station-id' });
  const plans = r.tick(at(20));
  assert.deepEqual(plans.map(p => `${p.kind}:${p.act}`), ['banter:fire', 'station-id:wait']);
  assert.deepEqual(r.minutesOf('banter'), [20]);
  assert.deepEqual(r.minutesOf('station-id'), [], 'the ident does not also speak');
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /^\[station-id\] stood down at :15 — banter took the minute \(retrying until :24\)$/);
});

test('a yielded slot is postponed, not cancelled', () => {
  // The loser keeps its window. Next minute the winner's slot is claimed, so
  // the ident that lost :20 speaks at :21 — this is the whole difference
  // between arbitration and the old "whoever the cron favoured wins outright".
  const r = makeReplay({ eligible: kind => kind === 'banter' || kind === 'station-id' });
  r.tick(at(20));
  r.tick(at(21));
  assert.deepEqual(r.minutesOf('banter'), [20]);
  assert.deepEqual(r.minutesOf('station-id'), [21]);
});

test('a row yields only to a row that is FIRING, never to one that is merely open', () => {
  // The subtle failure this rule exists to prevent: banter (higher priority)
  // is open across :20–:29 but blocked on its five-minute gap, while the ident
  // needs only three. A "yield to any open higher-priority row" reading would
  // hold the ident for the whole overlap and hand #1419 straight back, one
  // layer up. Talk aired at :21:00, so at :24 the ident is clear (180s) and
  // banter is not (300s needed).
  const r = makeReplay({
    lastTalkBreakAt: clockAt(21),
    eligible: kind => kind === 'banter' || kind === 'station-id',
  });
  const plans = r.tick(at(24));
  assert.deepEqual(plans.map(p => `${p.kind}:${p.act}`), ['banter:wait', 'station-id:fire']);
  assert.deepEqual(r.minutesOf('station-id'), [24]);
});

test('a programme beat outranks the hourly check, because a beat cannot retry', () => {
  // A station zone at a :30 offset puts a station-clock feature beat (:35–:39)
  // at process :05 — inside the hourly row's window. The beat has no window of
  // its own, so it takes the minute and the hourly check retries.
  const r = makeReplay({
    eligible: kind => kind === 'programme' || kind === 'hourly',
    externalSlot: kind => (kind === 'programme' ? 'feature' : null),
  });
  const plans = r.tick(at(5));
  assert.deepEqual(plans.map(p => `${p.kind}:${p.act}`), ['programme:fire', 'hourly:wait']);
  assert.match(r.logs[0], /^\[hourly\] stood down at :0 — programme took the minute/);
  // …and it does retry, at the next minute the beat is no longer due.
  r.tick(at(6));
  assert.deepEqual(r.minutesOf('hourly'), [6]);
});

// ---------------------------------------------------------------------------
// THE FILL ROW
// ---------------------------------------------------------------------------

test('the segment director is offered the same minutes its cron fired on', () => {
  const r = makeReplay({ eligible: kind => kind === 'segment' });
  r.hour();
  assert.deepEqual(r.minutesOf('segment'), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.equal(talkSlot('segment').role, 'fill');
  // Its cadence is the table's; how often it actually SPEAKS stays in
  // skills/_agent.ts, so the row carries no gap of its own.
  assert.equal(talkSlot('segment').minGapMs, 0);
});

test('the filler stands down for a slot row that is merely WAITING, not just firing', () => {
  // The asymmetry, and the whole point of folding it in. A talk break at :14
  // leaves the :15 ident waiting on its three-minute gap. Under its own cron the
  // director fired at :15 anyway, reset the gap, and pushed the ident to :18 —
  // one of the two off-clock talkers banter-policy.ts names as able to starve a
  // slot. Now it stands down and the ident takes :17.
  const r = makeReplay({
    lastTalkBreakAt: clockAt(14),
    feedback: true,
    eligible: kind => kind === 'segment' || kind === 'station-id',
  });
  for (let m = 15; m <= 20; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('station-id'), [17], 'the ident is no longer pushed out');
  // :15 was contested and yielded; :20 is genuinely free — the ident has
  // spoken and claimed its slot, so nothing wants that minute any more. The
  // filler stands down for a contested MINUTE, not for an open window.
  assert.deepEqual(r.minutesOf('segment'), [20]);
});

test("a contested minute never reaches the filler's own gates", () => {
  // Gate before generation, applied to arbitration: the filler's four gates are
  // cheap, but asking them on a minute it cannot have is the same shape of
  // waste as letting the LLM write a script the dispatcher throws away.
  const asked: TalkKind[] = [];
  const r = makeReplay({ eligible: kind => { asked.push(kind); return true; } });
  r.tick(at(15));  // the ident's chance opens
  assert.deepEqual(asked, ['station-id'], 'the filler is not even asked');
  asked.length = 0;
  // :10 and :40 are the only stride ticks no slot row's WINDOW can reach at
  // all, so they are free whatever else has happened this hour.
  r.tick(at(10));
  assert.deepEqual(asked, ['segment']);
});

test('the filler yields to a firing row, and takes the minutes nothing else wants', () => {
  // A clean, chatty hour: the filler loses the six opening minutes and keeps
  // the six the scheduled rows have finished with. That halving IS the fix —
  // those six were exactly the minutes it used to double-talk on — and the
  // count is pinned because it is the real cost of this PR.
  const r = makeReplay({ feedback: true });
  r.hour();
  assert.deepEqual(r.minutesOf('hourly'), [0]);
  assert.deepEqual(r.minutesOf('station-id'), [15, 30, 45]);
  assert.deepEqual(r.minutesOf('banter'), [20, 50]);
  assert.deepEqual(r.minutesOf('segment'), [5, 10, 25, 35, 40, 55]);
  // Every minute has at most one talker — the invariant the whole table exists
  // for, now that five kinds share it.
  const minutes = r.rang.map(x => x.minute);
  assert.equal(new Set(minutes).size, minutes.length, 'two segments aired in one minute');
});

test('deferring to an OPEN window rather than a wanted minute would switch the filler off', () => {
  // Why the rule is "a slot row wants this minute" and not "a slot row's window
  // is open". With ten-minute windows the scheduled rows cover 50 minutes of
  // the hour, so the second reading leaves the director :10 and :40 — not
  // standing down, switched off. A row that has already fired, or is ineligible,
  // produces no plan and wants nothing.
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
  // A filler that did not fill is not an event; a SCHEDULED segment that
  // quietly did not happen is #1419, and those still log. One booth-log line
  // per contested minute would bury the ones that matter.
  const r = makeReplay({ feedback: true });
  r.hour();
  assert.equal(r.logs.filter(l => l.startsWith('[segment]')).length, 0);
  assert.deepEqual(r.logs, [], 'a clear hour explains nothing at all');
});

// ---------------------------------------------------------------------------
// IN-FLIGHT TALK
// ---------------------------------------------------------------------------

test('a segment waiting for a track boundary holds every gap-gated row', () => {
  // #1419's root cause, from the side the window alone never fixed: an ident is
  // rendered at :15 and waits for the next transition. getLastTalkBreakAt()
  // reports what HAS aired, so at :20 the gap looks clear and banter fires ten
  // seconds in front of it. `pendingTalk` carries the queue's `_pendingVoice`
  // kind and enqueue time, so that protection is bounded by the clip's valid
  // life and by the blocked row's own remaining chances.
  const r = makeReplay({
    pendingTalk: { kind: 'station-id', queuedAt: clockAt(15) },
    eligible: kind => kind === 'banter',
  });
  r.tick(at(20));
  assert.deepEqual(r.minutesOf('banter'), [], 'in-flight talk is still talk');
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /^\[banter\] stood down at :20 — a station-id is rendered and waiting for the next track boundary \(retrying until :29\)$/);
  // It postpones like every other hold: once the ident airs, the window's
  // remaining minutes are the exchange's.
  const after = makeReplay({ eligible: kind => kind === 'banter' });
  after.tick(at(21));
  assert.deepEqual(after.minutesOf('banter'), [21]);
});

test('a pending segment fresh enough to outlast a window holds it — and says so', () => {
  // A freshly rendered ident can still validly air throughout this banter
  // window. Letting banter go first could stack the two at the next boundary,
  // so the pending-specific hold remains the right, operator-visible answer —
  // for every minute of the window except the last, which the next test owns.
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
  // #1539, and the test the issue asked for. `_pendingVoice` may legitimately
  // live PENDING_VOICE_MAX_AGE_MS, and it is dropped only at a track start, so
  // on a chatty station where every boundary carries its own link a clip can
  // outlast the window of the row it is holding. Unbounded, that row logged
  // `slot :NN missed` and — for the hourly check, which gets ONE chance an
  // hour — lost the whole hour, which is a hold quietly becoming a cancel.
  //
  // Both cases the issue names, with the enqueue times the rows themselves
  // produce: the ident's :45 window runs to :54, so a retry inside it stamps a
  // clip whose 20 minutes reach past the hourly window's :10 close and past
  // banter's :00 one. The window's last minute is the row's final chance and
  // the hold stands down for it.
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
  // The other end of the bound, and why it is two rules rather than one. A clip
  // that will expire before this window closes is dropped by the queue while
  // the row still has minutes left, so it was never able to cost the row its
  // slot: it does not hold even at the opening minute. Only a clip that
  // outlives the window is worth standing down for, and only until the last.
  const r = makeReplay({
    pendingTalk: { kind: 'station-id', queuedAt: clockAt(50, 0, HOUR - 1) },
    eligible: kind => kind === 'hourly',
  });
  for (let m = 0; m <= 9; m++) r.tick(at(m));
  assert.deepEqual(r.minutesOf('hourly'), [0], 'expires at :10, exactly when the window closes — the row keeps all ten minutes');
  assert.deepEqual(r.logs, []);
});

test('two simulated hours: a pending clip never eats a whole window, whatever else is happening', () => {
  // The unit tests above each pin one arranged minute. This drives the WHOLE
  // table for two hours against pseudo-random pending clips, quiet gaps and
  // eligibility, because the bug being fixed was not visible in any single
  // minute: the old comparison cancelled `now` out, so it read the same at
  // every minute of a window and only the whole window showed the loss.
  //
  // Seeded, so a failure is reproducible from the seed alone. Kept small enough
  // to stay a unit test; the same harness was run at 400 seeds x 120 minutes
  // against the pre-fix planner, where the `all-pending` count below was 256.
  const rand = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const minuteAt = (i: number) => new Date(2026, 7, 19, HOUR + Math.floor(i / 60), i % 60, 0);
  const TICKS = 120;
  let fullyPendingWindows = 0, lastMinutePendingHolds = 0, pendingHolds = 0, released = 0;

  for (let seed = 1; seed <= 12; seed++) {
    const rnd = rand(seed);
    // A boundary-deferred clip lands at random minutes and then sits in the
    // queue until it goes stale — exactly what a run of link-carrying
    // boundaries does to `_pendingVoice`.
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

      // ONE TALKER PER MINUTE (#310) survives the release.
      const firing = plans.filter(p => p.act === 'fire');
      assert.ok(firing.length <= 1, `seed ${seed} :${now.getMinutes()} — ${firing.map(p => p.kind)} all fired`);

      // The fill row still stands down — SILENTLY — to any slot row that wants
      // the minute, firing or merely waiting.
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
          // THE HOLD NEVER TAKES THE ROW'S LAST CHANCE. #1539 in one line.
          assert.ok(row.opens === 'external' || canRetry(row, plan.slot, now.getMinutes()),
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
  // `minGapMs: 0` means "this row does not ask about quiet", and a programme
  // beat that cannot retry must not be lost to a pending ident.
  const r = makeReplay({
    pendingTalk: { kind: 'station-id', queuedAt: clockAt(35) },
    eligible: kind => kind === 'programme',
    externalSlot: kind => (kind === 'programme' ? 'outro' : null),
  });
  r.tick(at(55));
  assert.deepEqual(r.minutesOf('programme'), [55]);
});

// ---------------------------------------------------------------------------
// THE FREQUENCY LADDER, PER SLOT
// ---------------------------------------------------------------------------

test('the ident rung reads the slot, so every retry minute keeps its chance', async () => {
  // `[15,30,45].includes(m)` would answer false for :18 and silently cancel
  // every retry the window exists to allow — the migration banter needed at
  // #1419 and the ident row needs now.
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
    // Outside every ident window nothing fires, whatever the rung — :00 in
    // particular stays the hourly check's (#310).
    for (const m of [0, 5, 9, 14, 25, 44, 55]) {
      assert.equal(shouldFire('stationId', at(m)), false, `${f} must not ident at :${m}`);
    }
  }
});

// ---------------------------------------------------------------------------
// PRIMITIVES
// ---------------------------------------------------------------------------

test('a retry minute keeps its slot identity, so one window is one chance', () => {
  const row = talkSlot('banter');
  for (const slot of BANTER_SLOTS) {
    for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
      assert.equal(openMinuteFor(row, slot + i), slot, `:${slot + i} should belong to slot :${slot}`);
    }
    assert.equal(windowEndMinute(row, slot), slot + BANTER_WINDOW_MINUTES - 1);
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

test('the stand-down lines carry the reason and the numbers, for all three causes', () => {
  const row = talkSlot('banter');
  const now = 1_000_000_000_000;
  const gap = talkGap({ nowMs: now, lastTalkBreakAt: now - 25_000, needMs: BANTER_MIN_GAP_MS });
  const line = standDownLine(row, '20', { held: 'gap', gap });
  // Which row, which cause, how long ago, how long is left — the row prefix
  // matters now that four kinds share one log channel.
  assert.match(line, /^\[banter\] stood down at :20 — last standalone talk 25s ago, minimum gap 300s \(retrying until :29\)$/);
  assert.match(missedLine(row, '20', { held: 'gap', gap }), /^\[banter\] slot :20 missed — last standalone talk 25s ago, minimum gap 300s; window closed at :29$/);
  // A fresh boot has no last break — the line must not print "Infinitys".
  assert.match(standDownLine(row, '20', { held: 'gap', gap: talkGap({ nowMs: now, lastTalkBreakAt: 0, needMs: 1 }) }), /never ago/);
  // The two causes that carry no numbers still name themselves precisely.
  assert.match(standDownLine(row, '20', { held: 'pending', pendingKind: 'station-id' }), /a station-id is rendered and waiting/);
  assert.match(standDownLine(row, '20', { held: 'yield', to: 'hourly' }), /hourly took the minute/);
});

test('a held beat is reported as lost, never as retrying', () => {
  // The programme row cannot retry — `dueBeat` is a window on the station clock
  // that the table samples once — so if anything ever holds it, the line must
  // say the beat is gone rather than promise a minute that will not come. It
  // leads the real table's priority order precisely so this cannot happen; a
  // synthetic table proves the wording without weakening that.
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
  // 15 minutes, that lands exactly one tick inside each beat window (:35–:39,
  // :55+) whatever the zone — which is what `*/5` did. A per-minute row would
  // add retries the old cron never had.
  assert.deepEqual(asked, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.deepEqual(r.minutesOf('programme'), asked);
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
  assert.equal(talkSlot('banter').oneFirePerSlot, true);
});

// ---------------------------------------------------------------------------
// LAZINESS — what the planner is allowed to ask, and when
// ---------------------------------------------------------------------------

test('policy is asked only for a row that is open and unfired', () => {
  const asked: TalkKind[] = [];
  const r = makeReplay({ eligible: kind => { asked.push(kind); return true; } });
  // :12 falls in no window at all — the hourly's closed at :09 and the ident's
  // opens at :15.
  r.tick(at(12));
  assert.deepEqual(asked, [], 'a closed window must not reach a policy module');
  // :15 opens the ident row, and a slot row wanting the minute stops the
  // filler's gates being asked at all (see the fill-row tests).
  r.tick(at(15));
  assert.deepEqual(asked, ['station-id']);
  // Second tick on the same minute: the ident's slot is claimed, so its gates
  // are not re-asked and it does not speak twice. (The guard is per ROW, not
  // per minute — with the ident's chance taken, a repeat tick would offer that
  // minute to the filler. node-cron fires a minute once, so this is only ever
  // the shape of the claim, not a case the station reaches.)
  asked.length = 0;
  r.tick(at(15));
  assert.ok(!asked.includes('station-id'), 'a claimed slot is not re-asked');
  assert.deepEqual(r.minutesOf('station-id'), [15], 'and does not air twice');
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
        now: at(m), lastTalkBreakAt: 0, pendingTalk: null,
        eligible: () => true, externalSlot: () => null, fired: {}, logged: {},
      }),
      null,
      `:${m} must not reach the gap check`,
    );
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
