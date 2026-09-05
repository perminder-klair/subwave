// Talk-slot scheduler — WHICH scheduled spoken segment may take the listener's
// ear this minute (#1500).
//
// The scheduler used to register one cron per talk kind — `0 * * * *` for the
// hourly check, `15,30,45 * * * *` for idents, a derived window expression for
// banter, `*/5 * * * *` for programme beats — and they coordinated only
// IMPLICITLY, by hand-partitioned minutes. That partitioning is real (see
// BANTER_SLOTS and dj-gate's ident rungs, both citing #310) but it is invisible:
// it lives in four cron strings in startScheduler() and three comments, and the
// two bugs it has already produced (#310, #1419) were both fixed by tightening
// the partitioning rather than by any arbitration anything could read.
//
// So the minutes become a TABLE and the crons become one `* * * * *` tick. This
// module is the pure half: rows in, a list of what to do this minute out. It
// owns DISPATCH only — every eligibility question (frequency rung, listeners,
// budget, clock switch, roster, programme state) still resolves through the
// existing policy modules at fire time, via the `eligible` resolver the caller
// injects. Adding a second copy of one of those checks here is the bug.
//
// The shape is banterTickPlan's, generalised: banter is the row that already
// had a window, a quiet gap and logged-once stand-downs, because #1419 forced
// them. Every row now carries all three, plus the two rules the old crons had
// no way to express:
//
//   - ONE TALKER PER MINUTE. When two rows would fire together, priority
//     decides and the loser WAITS INSIDE ITS WINDOW. #310 stops being a
//     partitioning convention nobody can read and becomes a rule in one place;
//     #1419's postpone-don't-cancel becomes universal.
//   - IN-FLIGHT TALK COUNTS, BUT NEVER PAST THE ROW'S LAST CHANCE. A boundary-
//     deferred ident is rendered and queued minutes before it airs, and
//     queue.getLastTalkBreakAt() — which reports what HAS aired — cannot see it.
//     That blind spot is #1419's actual root cause: the :20 tick reads a clear
//     gap, fires, and the ident lands ten seconds later anyway. `pendingTalk`
//     closes it. The hold is then bounded at both ends (#1539): a clip that
//     expires inside the window never blocks, and one that outlives it stops
//     blocking on the window's last retry minute, so a held row still fires
//     inside its window rather than logging `missed`.
//
// Pure and I/O-free (a `Date`, two counters and two injected resolvers in;
// plans out) so scripts/talk-scheduler.test.ts can walk an hour minute by minute
// without a scheduler, a clock or a station.

import {
  BANTER_SLOTS, BANTER_WINDOW_MINUTES, BANTER_MIN_GAP_MS,
} from './banter-policy.js';
import { pendingVoiceValidForMs } from './queue/kinds.js';
import type { PendingTalk } from './queue/kinds.js';

// ---------------------------------------------------------------------------
// THE SLOT TABLE
// ---------------------------------------------------------------------------

export type TalkKind = 'hourly' | 'programme' | 'banter' | 'station-id' | 'segment';

// Which clock a row's placement is a fact ABOUT. Two clocks coexist on purpose
// and a unified table must not collapse them: slot minutes run on PROCESS time
// because they have to agree with when the cron actually fires, while programme
// beats are a STATION-zone fact and station zones sit at :30/:45 offsets (IST,
// Nepal) where a fixed process minute would land mid-show. The hourly row is
// the mixed case — its minute is process, but the every-other-hour rung inside
// dj-gate reads the station hour.
export type TalkClock = 'process' | 'station';

// How a fired row reaches air. An ident has no real-time constraint, so it
// defers to the next track boundary rather than ducking the current song
// mid-vocal at an arbitrary wall-clock minute; everything else airs immediately
// through the voice queue. Per-row, never unified away.
export type TalkAir = 'immediate' | 'next-track';

// What a row IS, which decides what it may take the minute from.
//
//   'slot' — a scheduled chance. It owns its minutes, it yields only to a row
//            that is actually FIRING, and when it is held it says so.
//   'fill' — opportunistic. It has no scheduled chance to lose, so it stands
//            down whenever any slot row WANTS the minute (firing or waiting),
//            and it does so silently: "the filler did not fill this minute" is
//            not an event, where a scheduled segment quietly not happening is
//            exactly the #1419 failure worth logging.
//
// The asymmetry is the point. A slot row yielding to a merely-open row would
// let one row sit on its window starving everything beneath it; a fill row
// cannot be starved by yielding, because another chance is one stride away.
export type TalkRole = 'slot' | 'fill';

export type TalkSlot = {
  kind: TalkKind;
  // Minutes at which a window OPENS. 'external' for a row whose placement is
  // computed elsewhere (programme beats, which resolve on the station clock via
  // programme.dueBeat(), supplied through the `externalSlot` resolver), or 'any'
  // for a row with no scheduled minutes at all — every tick it is sampled on is
  // its own chance.
  opens: readonly number[] | 'external' | 'any';
  // How long a window stays open for, in minutes. 1 means "this minute only",
  // which is exactly the old fixed-instant cron.
  windowMinutes: number;
  // Minimum quiet gap since the last STANDALONE talk break before this row may
  // fire. 0 disables the check (the gap is then trivially clear), which is what
  // every row except banter carries today.
  minGapMs: number;
  air: TalkAir;
  role: TalkRole;
  // Who wins the minute when two rows would both fire. Lower is stronger; ties
  // break on table order. The ordering principle, so a new row can be placed
  // without guessing: A ROW THAT CANNOT RETRY OUTRANKS A ROW THAT CAN, and
  // among rows that can retry, the one with fewer chances left in the hour
  // outranks the one with more. That is why the programme beat leads (it has no
  // window of its own — a lost beat is lost), the hourly check comes next (one
  // chance an hour), then banter (two slots), then idents (three).
  priority: number;
  clock: TalkClock;
  // Only evaluate this row on process minutes divisible by `stride`. Exists so
  // the programme row keeps being sampled exactly where its old `*/5` cron
  // sampled it: with every real IANA offset a multiple of 15 minutes, a 5-minute
  // stride lands one tick inside each beat window (:35-:39, :55+) whatever the
  // zone, and a per-minute row would add retries the old cron never had.
  stride: number;
  // Whether the row remembers that a slot has already spoken. Banter needs it
  // (a per-minute window would otherwise stream exchanges); programme does NOT,
  // because its own beat flags live in session state and survive a restart —
  // a second in-memory guard here could only ever suppress a fire the old cron
  // would have made.
  oneFirePerSlot: boolean;
};

// Rows in priority order.
//
// Two families of number live here and they answer different questions. `opens`
// is WHERE a chance falls — hand-partitioned minutes with a reason (#310), and
// the frequency ladder in dj-gate.ts narrows them further per persona. Window
// and gap are HOW LONG that chance lasts and HOW MUCH quiet it needs: they are
// what turn a missed instant into a postponed one.
//
// The gaps are shorter than banter's on purpose. Banter is the longest break
// the station airs, so it holds out for five clear minutes; an ident and a time
// check are seconds long, and three minutes is enough to stop them landing on
// the back of a segment that just finished — which is the whole of #310,
// stated as a number instead of as an absent cron minute.
export const TALK_SLOTS: readonly TalkSlot[] = [
  // Programme beats — the feature mid-hour and the outro in the final minutes
  // of the show's last hour, both placed on the station clock by
  // programme.dueBeat(). Gating lives in programme.ts; this row only says when
  // to ask. It leads the table because it is the one row that CANNOT retry:
  // `dueBeat` is a window on the station clock that this row samples once, so a
  // beat that yields is a beat the episode never gets. It takes no gap for the
  // same reason — a planned episode's beats are the show, not an interruption
  // of it.
  {
    kind: 'programme',
    opens: 'external',
    windowMinutes: 1,
    minGapMs: 0,
    air: 'immediate',
    role: 'slot',
    priority: 1,
    clock: 'station',
    stride: 5,
    oneFirePerSlot: false,
  },
  // Top of the hour: the DJ checks in. The window runs to :09 — past that it is
  // no longer a top-of-hour check, and the next one is only 50 minutes away.
  // The script is written at FIRE time, not at :00, so a check postponed to
  // :04 still reads the clock correctly (broadcast/queue's spoken-clock guards
  // cover the drift that remains).
  //
  // Note the SESSION ROLL that used to share this row's cron is not a row at
  // all — it is unconditional and runs before any of this (see
  // scheduler.talkTick), because a muted or empty station must still roll its
  // session, plan the episode and settle a pending handoff.
  {
    kind: 'hourly',
    opens: [0],
    windowMinutes: 10,
    minGapMs: 3 * 60_000,
    air: 'immediate',
    role: 'slot',
    priority: 2,
    clock: 'process',
    stride: 1,
    oneFirePerSlot: true,
  },
  // Guest-show banter — the row that had a window and a gap first, because
  // #1419 forced them. Its numbers keep their reasoning in banter-policy.ts and
  // are imported rather than restated.
  {
    kind: 'banter',
    opens: BANTER_SLOTS,
    windowMinutes: BANTER_WINDOW_MINUTES,
    minGapMs: BANTER_MIN_GAP_MS,
    air: 'immediate',
    role: 'slot',
    priority: 3,
    clock: 'process',
    stride: 1,
    oneFirePerSlot: true,
  },
  // Station idents. Candidate minutes are :15/:30/:45 — deliberately NOT :00,
  // which the hourly check owns; firing both there stacked two voice segments
  // back to back (#310). The frequency rung narrows the three to one or two,
  // and asks per SLOT, so a retry at :18 still reads as the :15 chance.
  //
  // The ten-minute window is what stops an ident vanishing when its minute is
  // busy: an ident that loses :15 to a segment retries through :24 instead of
  // waiting for :30 (and, on `quiet`, for the next hour). It is also the row
  // most likely to yield — three chances an hour is the most of any row, so it
  // is the cheapest to postpone.
  {
    kind: 'station-id',
    opens: [15, 30, 45],
    windowMinutes: 10,
    minGapMs: 3 * 60_000,
    air: 'next-track',
    role: 'slot',
    priority: 4,
    clock: 'process',
    stride: 1,
    oneFirePerSlot: true,
  },
  // The segment director — weather, news, a now-playing dig, a fact. The only
  // talker with no wall-clock placement at all: it is offered every fifth
  // minute and decides for itself whether it has anything to say. That is why
  // it is a FILL row rather than a slot, and why it carries no gap of its own —
  // its cooldowns and frequency floor live in skills/_agent.ts, which is where
  // they belong (a second copy here would be the bug this table exists to
  // avoid).
  //
  // Before #1500 it was the loudest uncoordinated voice on the station: a
  // `*/5` cron with a floor of ZERO on `aggressive`, ticking on :00, :15, :20,
  // :30, :45 and :50 — every opening minute the other rows own. It is named in
  // banter-policy.ts as one of the two things that could air off-clock and
  // starve a slot, and #1419 is half its doing. Standing it down on the minutes
  // another row wants is the second half of that fix.
  {
    kind: 'segment',
    opens: 'any',
    windowMinutes: 1,
    minGapMs: 0,
    air: 'immediate',
    role: 'fill',
    priority: 5,
    clock: 'process',
    stride: 5,
    oneFirePerSlot: true,
  },
];

export function talkSlot(kind: TalkKind, slots: readonly TalkSlot[] = TALK_SLOTS): TalkSlot {
  const row = slots.find(s => s.kind === kind);
  if (!row) throw new Error(`no talk slot for kind '${kind}'`);
  return row;
}

// The window a minute falls in, identified by its OPENING minute, or null
// outside every window. Windows never cross an hour boundary by construction
// (the widest opens at :50 and runs to :59), which is what lets a slot be keyed
// by wall-clock hour below.
export function openMinuteFor(row: TalkSlot, minute: number): number | null {
  if (row.opens === 'external') return null;
  // A row with no scheduled minutes opens a fresh chance on every tick it is
  // sampled on — the stride is its whole schedule.
  if (row.opens === 'any') return minute;
  for (const open of row.opens) {
    if (minute >= open && minute < open + row.windowMinutes) return open;
  }
  return null;
}

// Last minute of a window — the row's final chance, and what a stand-down line
// quotes so an operator can see how long is left.
export function windowEndMinute(row: TalkSlot, openMinute: number): number {
  return openMinute + row.windowMinutes - 1;
}

// Stable identity for "this hour's :20 window", so one fire per slot survives a
// per-minute tick without a timer or a countdown. Process-local time, like every
// other minute-slot decision here: the cron fires on process minutes, so the key
// must agree with it. A DST fall-back repeats an hour and re-opens a slot once —
// harmless, and strictly better than a forward jump silently consuming one.
export function talkSlotKey(kind: TalkKind, now: Date, slot: string): string {
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  return `${kind}-${day}-${now.getHours()}-${slot}`;
}

// ---------------------------------------------------------------------------
// THE QUIET GAP
// Every STANDALONE talk break counts — idents, hourly, handoff, banter and the
// segment director's spots — which is what queue.getLastTalkBreakAt() reports.
// Track-tied links are excluded there, or a chatty DJ-mode station would never
// clear a gap at all.
// ---------------------------------------------------------------------------

export type TalkGap = { clear: boolean; sinceMs: number; needMs: number };
// Re-exported, not redeclared: the shape and the age limit that gives
// `queuedAt` its meaning live together in queue/kinds.ts.
export type { PendingTalk };

// `lastTalkBreakAt` is 0 when nothing has aired yet (a fresh boot), which reads
// as an infinite gap — correct: there is no break to stack onto. `needMs: 0`
// makes every gap clear, which is how a row opts out of the check entirely.
export function talkGap(p: { nowMs: number; lastTalkBreakAt: number; needMs: number }): TalkGap {
  const sinceMs = p.lastTalkBreakAt > 0 ? p.nowMs - p.lastTalkBreakAt : Infinity;
  return { clear: sinceMs >= p.needMs, sinceMs, needMs: p.needMs };
}

function slotLabel(row: TalkSlot, slot: string): string {
  return row.opens === 'external' ? slot : `:${slot}`;  // 'any' labels by its minute, like a fixed row
}

// Whether a held row gets another minute at all. A fixed row does until its
// window's last minute; an `opens: 'external'` row NEVER does — its placement is
// a window on someone else's clock that this table samples once, so a held beat
// is a lost beat. The distinction has to reach the log line, or an operator
// reads "retrying until…" about a chance that has already gone.
export function canRetry(row: TalkSlot, slot: string, minute: number): boolean {
  if (row.opens === 'external') return false;
  return minute < windowEndMinute(row, Number(slot));
}

function sinceLabel(gap: TalkGap): string {
  return Number.isFinite(gap.sinceMs) ? `${Math.round(gap.sinceMs / 1000)}s` : 'never';
}

// WHY a row stood down. Three things can hold a slot, and an operator reading
// the booth log needs to tell them apart: a quiet gap that hasn't elapsed, a
// rendered segment still waiting for a track boundary, and another row that
// took the minute. Each carries its own numbers.
export type TalkWaitReason =
  | { held: 'gap'; gap: TalkGap }
  | { held: 'pending'; pendingKind: string }
  | { held: 'yield'; to: TalkKind };

// The clause that says what is holding the slot. Kept as one function so the
// stand-down and missed lines can't describe the same cause differently.
function becauseOf(reason: TalkWaitReason): string {
  if (reason.held === 'gap') {
    return `last standalone talk ${sinceLabel(reason.gap)} ago, `
      + `minimum gap ${Math.round(reason.gap.needMs / 1000)}s`;
  }
  if (reason.held === 'pending') {
    return `a ${reason.pendingKind} is rendered and waiting for the next track boundary`;
  }
  return `${reason.to} took the minute`;
}

// The stand-down line: the reason AND the numbers behind it, so this class of
// scheduling collision is visible in the booth log instead of being inferred
// from an absence. Logged once per slot by the caller (a per-minute tick would
// otherwise repeat it for every minute of the window).
export function standDownLine(row: TalkSlot, slot: string, reason: TalkWaitReason): string {
  const until = row.opens === 'external' ? '' : `:${windowEndMinute(row, Number(slot))}`;
  return `[${row.kind}] stood down at ${slotLabel(row, slot)} — ${becauseOf(reason)} `
    + `(retrying until ${until})`;
}

// The window closed unfired. Carries the same numbers, because this is the only
// line an operator gets when the very last minute of a window is the first one
// to be blocked.
export function missedLine(row: TalkSlot, slot: string, reason: TalkWaitReason): string {
  const tail = row.opens === 'external'
    ? 'and it has no second chance'
    : `window closed at :${windowEndMinute(row, Number(slot))}`;
  return `[${row.kind}] slot ${slotLabel(row, slot)} missed — ${becauseOf(reason)}; ${tail}`;
}

// ---------------------------------------------------------------------------
// THE TICK'S STATE MACHINE
// What one talk tick should do, as a pure decision over the clock, the per-kind
// slot counters and two injected resolvers. Split out for the same reason
// banterTickPlan and skillCronAllowed take their gates as parameters: the rule
// is worth pinning, and it cannot be if it reads live settings, listener and
// budget state itself.
//
// The ORDER inside a row matters and is banterTickPlan's pre-#1419 order:
// stride, then window, then "already spoke", then eligibility, and only then
// the gap — so an ineligible show never logs a stand-down about a gap that was
// never going to be asked about.
// ---------------------------------------------------------------------------

export type TalkPlan =
  // In the window and eligible, but something is holding the slot — the quiet
  // gap, a rendered segment still waiting for a boundary, or a higher-priority
  // row that took the minute. `log` is the one line to write (null when this
  // slot has already reported) and `markLogged` is what the caller should
  // remember so the next minute stays quiet.
  | { kind: TalkKind; act: 'wait'; slot: string; slotKey: string; reason: TalkWaitReason; log: string | null; markLogged: string | null }
  // Air it. The caller claims `slotKey` BEFORE awaiting the segment.
  | { kind: TalkKind; act: 'fire'; slot: string; slotKey: string; gap: TalkGap };

export type TalkTickInput = {
  now: Date;
  lastTalkBreakAt: number;
  // A segment already rendered and queued for the next track boundary, with
  // the age anchor from queue's `_pendingVoice`, or null. This is talk that has
  // NOT aired, so `lastTalkBreakAt` cannot see it, and it is the reason a :20
  // banter tick could read a clear gap and still land ten seconds in front of a
  // :15 ident (#1419). It blocks only while its queue life outlives the row's
  // window AND the row still has a retry minute to spend (#1539). Rows with
  // `minGapMs: 0` ignore the question entirely.
  pendingTalk: PendingTalk | null;
  // Resolved lazily, and only for a row whose window is actually open and
  // unfired — the live gates are cheap but they are policy, and evaluating them
  // for a row that isn't due would report a stand-down nobody asked about.
  eligible: (kind: TalkKind) => boolean;
  // The open slot for an `opens: 'external'` row, or null.
  externalSlot: (kind: TalkKind) => string | null;
  fired: Partial<Record<TalkKind, string | null>>;
  logged: Partial<Record<TalkKind, string | null>>;
  slots?: readonly TalkSlot[];
};

// A held slot, with the log-once bookkeeping every hold shares: the window's
// LAST minute reports the chance being lost (and always reports, since it may
// be the first blocked minute), any other minute reports once per slot and then
// stays quiet.
function waitPlan(row: TalkSlot, slot: string, slotKey: string, reason: TalkWaitReason, p: TalkTickInput): TalkPlan {
  const base = { kind: row.kind, act: 'wait' as const, slot, slotKey, reason };
  // A fill row standing down is its normal operating mode, not an exception —
  // it had no scheduled chance to lose. Narrating it would put a line in the
  // booth log on most ticks and bury the ones that matter.
  if (row.role === 'fill') return { ...base, log: null, markLogged: null };
  if (!canRetry(row, slot, p.now.getMinutes())) {
    return { ...base, log: missedLine(row, slot, reason), markLogged: null };
  }
  // Once per slot, not once per tick: the stand-down used to be a bare
  // `return`, which is why a starved hour left nothing in the log to explain
  // itself (#1419).
  if (p.logged[row.kind] === slotKey) return { ...base, log: null, markLogged: null };
  return { ...base, log: standDownLine(row, slot, reason), markLogged: slotKey };
}

// Whether the pending clip's remaining queue life reaches PAST this row's
// precise window close — that is, whether it could still be sitting on a
// boundary after the row's last chance has gone. A clip that will expire inside
// the window is dropped by the queue before the window is out, so it cannot be
// the reason the row never speaks; one that outlives the window can be, which
// is the half of the hold #1539 had to bound. Equality favours the scheduled
// row. Queue still owns the eventual stale drop.
//
// Only ever asked of a row that can retry, so `Number(slot)` is a real opening
// minute here (canRetry answers false for the one `opens: 'external'` row).
function pendingOutlivesWindow(row: TalkSlot, slot: string, pending: PendingTalk, nowMs: number): boolean {
  const windowClose = new Date(nowMs);
  windowClose.setMinutes(windowEndMinute(row, Number(slot)) + 1, 0, 0);
  const windowRemainingMs = Math.max(0, windowClose.getTime() - nowMs);
  return pendingVoiceValidForMs(pending.queuedAt, nowMs) > windowRemainingMs;
}

// One row's decision, or null for "nothing to do" — outside the window, already
// spoken, or not eligible this minute. Silent by design: a per-minute tick that
// narrated every ineligible minute would bury the booth log.
//
// Arbitration is NOT here: this answers "would this row like the minute?", and
// talkTickPlan below resolves the rows that both would.
export function talkSlotPlan(row: TalkSlot, p: TalkTickInput): TalkPlan | null {
  const minute = p.now.getMinutes();
  if (minute % row.stride !== 0) return null;
  const slot = row.opens === 'external'
    ? p.externalSlot(row.kind)
    : openMinuteFor(row, minute)?.toString() ?? null;
  if (slot == null) return null;
  const slotKey = talkSlotKey(row.kind, p.now, slot);
  if (row.oneFirePerSlot && p.fired[row.kind] === slotKey) return null;
  if (!p.eligible(row.kind)) return null;
  // A row that runs a gap check is asking "has the listener had a moment of
  // quiet?", and a rendered segment queued for the next boundary is the same
  // question's answer arriving late. Checked before the gap because it is the
  // more specific reason, and the operator wants the specific one.
  //
  // Bounded twice, because an unbounded hold turns postpone into cancel
  // (#1539). A clip that will EXPIRE INSIDE this window is dropped by the queue
  // before the row runs out of chances, so it never blocks at all. A clip that
  // outlives the window blocks only while the row HAS A RETRY MINUTE LEFT: the
  // window's last minute is the row's final chance and is never given away, so
  // a held row still fires inside its window. Taking that minute may land in
  // front of a clip that airs seconds later, and that is the trade — a stacked
  // break the operator can hear beats an hourly check that silently never
  // happened, which is postpone-don't-cancel applied to the one holder that
  // could otherwise sit on a whole window.
  const pending = p.pendingTalk;
  if (row.minGapMs > 0 && pending
      && canRetry(row, slot, minute)
      && pendingOutlivesWindow(row, slot, pending, p.now.getTime())) {
    return waitPlan(row, slot, slotKey, { held: 'pending', pendingKind: pending.kind }, p);
  }
  const gap = talkGap({ nowMs: p.now.getTime(), lastTalkBreakAt: p.lastTalkBreakAt, needMs: row.minGapMs });
  if (gap.clear) return { kind: row.kind, act: 'fire', slot, slotKey, gap };
  return waitPlan(row, slot, slotKey, { held: 'gap', gap }, p);
}

// Everything this minute has to do, in dispatch order. Rows that have nothing
// to do are absent rather than present-and-skipped, so the caller's loop is the
// list of things that actually happen.
//
// ONE TALKER PER MINUTE. Where the old crons partitioned minutes by hand so two
// segments could not be scheduled together (#310), the table lets windows
// overlap — an ident's :15 window now reaches into banter's :20 one — and
// resolves the overlap here instead. The loser does NOT lose its slot: it waits
// inside its own window and takes the next clear minute, which is #1419's
// postpone-don't-cancel rule generalised from banter to every row.
//
// A row yields only to a row that is FIRING this minute, never to one that is
// merely open. Yielding to an open-but-blocked row would let a high-priority
// row sit on its whole window holding everything below it — the same starvation
// #1419 was, one layer up.
export function talkTickPlan(p: TalkTickInput): TalkPlan[] {
  const rows = p.slots ?? TALK_SLOTS;
  const planOf = (role: TalkRole) => {
    const found: { row: TalkSlot; plan: TalkPlan; index: number }[] = [];
    rows.forEach((row, index) => {
      if (row.role !== role) return;
      const plan = talkSlotPlan(row, p);
      if (plan) found.push({ row, plan, index });
    });
    return found;
  };

  // Slot rows first, and fill rows are only PLANNED if none of them wanted the
  // minute. A fill row stands down whenever a slot row wants it — firing, or
  // waiting inside its window for a gap to clear. Waiting counts because a
  // filler that speaks now resets the quiet gap and pushes that row's retry
  // further out, possibly past its window: the harm is the same whether the
  // scheduled segment is about to air or about to be allowed to.
  //
  // "Wants the minute" is deliberately narrower than "has an open window". With
  // ten-minute windows the slot rows cover 50 of the 60 minutes, so deferring
  // to open WINDOWS would leave the segment director two ticks an hour instead
  // of six — it would not be standing down, it would be switched off. A row
  // that has already fired its slot, or is ineligible this minute, produces no
  // plan and wants nothing.
  //
  // Asking in two passes rather than filtering afterwards keeps the laziness
  // the whole planner is built on: on a contested minute the filler's own gates
  // are never consulted, the same reason eligibility is resolved per open row
  // rather than up front.
  const out = planOf('slot');
  if (!out.length) out.push(...planOf('fill'));
  // Stable: equal priorities keep table order, so the table itself stays the
  // one place the running order is written down.
  out.sort((a, b) => (a.row.priority - b.row.priority) || (a.index - b.index));
  const contenders = out;

  // ONE TALKER PER MINUTE. Where the old crons partitioned minutes by hand so
  // two segments could not be scheduled together (#310), the table lets windows
  // overlap — an ident's :15 window now reaches into banter's :20 one — and
  // resolves the overlap here instead. The loser does NOT lose its slot: it
  // waits inside its own window and takes the next clear minute, which is
  // #1419's postpone-don't-cancel rule generalised from banter to every row.
  //
  // A row yields only to a row that is FIRING, never to one that is merely
  // open. Yielding to an open-but-blocked row would let a high-priority row sit
  // on its whole window holding everything below it — the same starvation
  // #1419 was, one layer up. (A fill row is the deliberate exception above, and
  // is exempt from the starvation argument for the same reason: it has no slot
  // to lose.)
  let speaker: TalkKind | null = null;
  return contenders.map(({ row, plan }) => {
    if (plan.act !== 'fire') return plan;
    if (!speaker) { speaker = row.kind; return plan; }
    return waitPlan(row, plan.slot, plan.slotKey, { held: 'yield', to: speaker }, p);
  });
}
