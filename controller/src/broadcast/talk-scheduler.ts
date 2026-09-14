// Talk-slot scheduler: which scheduled spoken segment may take the listener's
// ear this minute (#1500). One slot table, one `* * * * *` tick.
//
// This module owns DISPATCH only. Every eligibility question (frequency rung,
// listeners, budget, clock switch, roster, programme state) still resolves
// through its own policy module at fire time, via the injected `eligible`
// resolver; a second copy of one of those checks here is the bug.
//
// Two rules the old per-kind crons could not express:
//   - One talker per minute. Priority decides; the loser WAITS inside its own
//     window rather than losing the slot (#310, #1419).
//   - In-flight talk counts, but never past a row's last chance. A boundary-
//     deferred clip has not aired, so getLastTalkBreakAt() cannot see it
//     (#1419); the resulting hold is bounded at both ends (#1539).
//
// Pure and I/O-free so scripts/talk-scheduler.test.ts can walk an hour minute by
// minute.

import {
  BANTER_SLOTS, BANTER_WINDOW_MINUTES, BANTER_MIN_GAP_MS,
} from './banter-policy.js';
import { HANDOVER_OFFSET_STEP_MINUTES } from '../schemas/settings.js';
import { pendingVoiceValidForMs } from './queue/kinds.js';
import type { PendingTalk } from './queue/kinds.js';

// ---------------------------------------------------------------------------
// THE SLOT TABLE
// ---------------------------------------------------------------------------

export type TalkKind = 'hourly' | 'programme' | 'banter' | 'station-id' | 'segment' | 'jingle';

// `jingle` is the one row that is not SPEECH. It is here because the table is
// where every claim on the listener's ear is arbitrated, and a stinger takes
// the seam exactly the way an ident does — which is the whole of #1619: while
// Liquidsoap drew the rotate itself, the planner could only find out
// afterwards, through the `jingle-playing.json` hold, and a link written for
// the next boundary landed right behind it.

// Which clock a row's placement is a fact about. Do not collapse the two: slot
// minutes are PROCESS time (they must agree with when the cron fires), while
// programme beats are a STATION-zone fact and station zones sit at :30/:45
// offsets where a fixed process minute would land mid-show.
export type TalkClock = 'process' | 'station';

// How a fired row reaches air. Per-row and never unified away; idents defer to a
// track boundary, everything else ducks the song. `djTalkOnlyBetweenTracks`
// (#1485, broadcast/talk-air.ts) reads every row as 'next-track'.
export type TalkAir = 'immediate' | 'next-track';

// 'slot' owns scheduled minutes: it yields only to a row that is actually
// FIRING, and logs when it is held. 'fill' is opportunistic: it stands down
// silently whenever any slot row WANTS the minute (firing or waiting). The
// asymmetry is deliberate — a slot row yielding to a merely-open row would let
// that row sit on its window starving everything beneath it, while a fill row
// cannot be starved because another chance is one stride away.
export type TalkRole = 'slot' | 'fill';

export type TalkSlot = {
  kind: TalkKind;
  // Minutes at which a window OPENS. 'external' means placement is computed
  // elsewhere and supplied via `externalSlot` (programme beats, on the station
  // clock); 'any' means every sampled tick is its own chance.
  opens: readonly number[] | 'external' | 'any';
  // Window length in minutes; 1 is "this minute only".
  windowMinutes: number;
  // Minimum quiet gap since the last STANDALONE talk break. 0 disables the
  // check (the gap then reads clear).
  minGapMs: number;
  air: TalkAir;
  role: TalkRole;
  // Who wins a contested minute. Lower is stronger; ties break on table order.
  // The ordering principle, so a new row can be placed without guessing: a row
  // that cannot retry outranks one that can, and among those that can, fewer
  // remaining chances outranks more.
  priority: number;
  clock: TalkClock;
  // Only evaluate this row on process minutes divisible by `stride`. For the
  // programme row this is a contract, not a convenience (#1576): a window
  // narrower than the stride, or opening off a multiple of it, is never sampled
  // and the show silently stops signing off. So the stride and the bound on
  // `handover.offsetMinutes` are the same constant from schemas/settings.ts.
  stride: number;
  // Whether the row remembers a slot has already spoken. Programme does not:
  // its beat flags live in session state and survive a restart, so a second
  // in-memory guard could only suppress a legitimate fire.
  oneFirePerSlot: boolean;
};

// Rows in priority order. `opens` is where a chance falls (hand-partitioned,
// #310; dj-gate's frequency ladder narrows it further per persona); window and
// gap are how long that chance lasts and how much quiet it needs. The 3-minute
// gaps are shorter than banter's five because an ident or time check is seconds
// long.
export const TALK_SLOTS: readonly TalkSlot[] = [
  // Programme beats: the mid-hour feature and the final-hour outro (the show's
  // sign-off), placed on the station clock by programme.dueBeat(); gating lives
  // in programme.ts. Leads the table because it is the one row that CANNOT
  // retry — this row samples dueBeat's window once, so a yielded beat is lost.
  // `handover.offsetMinutes` (#1576) MOVES the outro window and never resizes
  // it: one stride wide, aligned to a multiple of the stride, which is why the
  // stride below is the imported constant rather than a literal.
  {
    kind: 'programme',
    opens: 'external',
    windowMinutes: 1,
    minGapMs: 0,
    air: 'immediate',
    role: 'slot',
    priority: 1,
    clock: 'station',
    stride: HANDOVER_OFFSET_STEP_MINUTES,
    oneFirePerSlot: false,
  },
  // Top of the hour. The window runs to :09; the script is written at FIRE time,
  // so a postponed check still reads the clock correctly. The :00 SESSION ROLL
  // is not a row — it runs unconditionally before the planner (scheduler.talkTick),
  // because a muted or empty station must still roll.
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
  // Guest-show banter. Its numbers live in banter-policy.ts and are imported.
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
  // Station idents at :15/:30/:45, deliberately NOT :00 (the hourly check owns
  // it; firing both stacked two segments back to back, #310). The frequency rung
  // asks per SLOT, so a retry at :18 still reads as the :15 chance. Three
  // chances an hour makes this the cheapest row to postpone.
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
  // The segment director: no wall-clock placement, offered every fifth minute,
  // decides for itself whether it has anything to say. Hence a FILL row, and
  // hence no gap of its own — its cooldowns and frequency floor stay in
  // skills/_agent.ts.
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
  // The automatic jingle rotate (#1619) — the row that is not speech.
  //
  // ROLE. It is the table's SECOND fill row, and the choice is the same
  // argument the segment director's is, not a weaker version of it. A fill row
  // is one with "no scheduled chance to lose", and that is exactly what a
  // rotate is: its due-ness is a COUNT of track boundaries
  // (queue.rotateJingleTracksSince()), which keeps counting while the row
  // waits, so a minute given away costs nothing but a minute. Making it a slot
  // row would be wrong twice — it would suppress the director on every minute
  // the jingle is merely waiting, and every hold would log `missed` about a
  // chance that was never lost, since an `opens: 'any'` row's window is one
  // minute wide and `canRetry` is therefore false on all of them.
  //
  // What the issue asked for — "the segment director stands down for it the way
  // it does for an ident" — is what one talker per minute already does between
  // two fill rows: the higher-priority plan takes the minute and the other one
  // waits. It does not need to be a slot to get that.
  //
  // PRIORITY. Last, by the table's own principle: among rows that can retry,
  // fewer remaining chances outranks more. The director is offered twelve
  // minutes an hour; this row is offered sixty. So on a contested minute the
  // director speaks and the jingle takes one of its other fifty-nine.
  //
  // GAP. Three minutes, the short segments' figure, and it is the half of the
  // #310 collision this row can actually answer: a stinger must not land on the
  // back of a break that has just finished. The other half — talk landing on
  // the back of the STINGER — is not this row's to enforce and stays where it
  // already lives, in the `jingle-playing.json` hold (#997, #1258, #1468) and
  // radio.liq's own `voice_until` gate on the priority queue, which is why that
  // guard survives this change untouched. Note the gap is one-directional for a
  // second reason too: a jingle is not talk, so it never appears in
  // queue.getLastTalkBreakAt().
  //
  // AIR. 'immediate' describes the HANDOFF, which is all the controller does
  // here — the write to jingle-now.txt happens now and Liquidsoap's
  // jingle_now_queue, a track-sensitive fallback gated on voice and beds,
  // places the clip at the next safe boundary. Claiming 'next-track' would say
  // the controller is deferring something it is not.
  {
    kind: 'jingle',
    opens: 'any',
    windowMinutes: 1,
    minGapMs: 3 * 60_000,
    air: 'immediate',
    role: 'fill',
    priority: 6,
    clock: 'process',
    stride: 1,
    // The counter is the guard: it is zeroed when the jingle is handed over, so
    // the row cannot fire twice for one rotate. An in-memory slot claim would
    // only duplicate that, and keyed by minute (an `opens: 'any'` row's slot IS
    // its minute) it would expire a tick later anyway.
    oneFirePerSlot: false,
  },
];

export function talkSlot(kind: TalkKind, slots: readonly TalkSlot[] = TALK_SLOTS): TalkSlot {
  const row = slots.find(s => s.kind === kind);
  if (!row) throw new Error(`no talk slot for kind '${kind}'`);
  return row;
}

// The window a minute falls in, identified by its OPENING minute, or null
// outside every window. Windows never cross an hour boundary by construction,
// which is what lets a slot be keyed by wall-clock hour below.
export function openMinuteFor(row: TalkSlot, minute: number): number | null {
  if (row.opens === 'external') return null;
  // No scheduled minutes: the stride is the whole schedule.
  if (row.opens === 'any') return minute;
  for (const open of row.opens) {
    if (minute >= open && minute < open + row.windowMinutes) return open;
  }
  return null;
}

// Last minute of a window: the row's final chance.
export function windowEndMinute(row: TalkSlot, openMinute: number): number {
  return openMinute + row.windowMinutes - 1;
}

// Stable identity for "this hour's :20 window", so one-fire-per-slot survives a
// per-minute tick with no timer. Process-local time, because the cron fires on
// process minutes. A DST fall-back re-opens a slot once; harmless.
export function talkSlotKey(kind: TalkKind, now: Date, slot: string): string {
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  return `${kind}-${day}-${now.getHours()}-${slot}`;
}

// The quiet gap. Every STANDALONE talk break counts, which is what
// queue.getLastTalkBreakAt() reports; track-tied links are excluded there, or a
// chatty DJ-mode station would never clear a gap.

export type TalkGap = { clear: boolean; sinceMs: number; needMs: number };
// Re-exported, not redeclared: shape and age limit live in queue/kinds.ts.
export type { PendingTalk };

// `lastTalkBreakAt` 0 (fresh boot) reads as an infinite gap; `needMs: 0` makes
// every gap clear, which is how a row opts out.
export function talkGap(p: { nowMs: number; lastTalkBreakAt: number; needMs: number }): TalkGap {
  const sinceMs = p.lastTalkBreakAt > 0 ? p.nowMs - p.lastTalkBreakAt : Infinity;
  return { clear: sinceMs >= p.needMs, sinceMs, needMs: p.needMs };
}

function slotLabel(row: TalkSlot, slot: string): string {
  return row.opens === 'external' ? slot : `:${slot}`;  // 'any' labels by its minute, like a fixed row
}

// Whether a held row gets another minute. A fixed row does until its window's
// last minute; an `opens: 'external'` row never does, since its placement is
// sampled once.
export function canRetry(row: TalkSlot, slot: string, minute: number): boolean {
  if (row.opens === 'external') return false;
  return minute < windowEndMinute(row, Number(slot));
}

function sinceLabel(gap: TalkGap): string {
  return Number.isFinite(gap.sinceMs) ? `${Math.round(gap.sinceMs / 1000)}s` : 'never';
}

// Why a row stood down: an unelapsed quiet gap, a rendered segment waiting for a
// track boundary, or another row taking the minute.
export type TalkWaitReason =
  | { held: 'gap'; gap: TalkGap }
  | { held: 'pending'; pendingKind: string }
  | { held: 'yield'; to: TalkKind };

// One function so the stand-down and missed lines can't word a cause differently.
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

// Logged once per slot by the caller; a per-minute tick would otherwise repeat
// it for every minute of the window.
export function standDownLine(row: TalkSlot, slot: string, reason: TalkWaitReason): string {
  const until = row.opens === 'external' ? '' : `:${windowEndMinute(row, Number(slot))}`;
  return `[${row.kind}] stood down at ${slotLabel(row, slot)} — ${becauseOf(reason)} `
    + `(retrying until ${until})`;
}

// The window closed unfired.
export function missedLine(row: TalkSlot, slot: string, reason: TalkWaitReason): string {
  const tail = row.opens === 'external'
    ? 'and it has no second chance'
    : `window closed at :${windowEndMinute(row, Number(slot))}`;
  return `[${row.kind}] slot ${slotLabel(row, slot)} missed — ${becauseOf(reason)}; ${tail}`;
}

// What one talk tick should do, as a pure decision over the clock, the per-kind
// slot counters and two injected resolvers. The ORDER inside a row is
// load-bearing: stride, window, "already spoke", eligibility, then the gap — so
// an ineligible show never logs a stand-down about a gap nobody asked about.

export type TalkPlan =
  // In the window and eligible, but held. `log` is the one line to write (null
  // when this slot already reported); `markLogged` is what the caller remembers
  // so the next minute stays quiet.
  | { kind: TalkKind; act: 'wait'; slot: string; slotKey: string; reason: TalkWaitReason; log: string | null; markLogged: string | null }
  // Air it. The caller claims `slotKey` BEFORE awaiting the segment. `air` is
  // RESOLVED for this tick, not the row's own value, and is carried on the plan
  // so the dispatcher never re-derives it.
  | { kind: TalkKind; act: 'fire'; slot: string; slotKey: string; gap: TalkGap; air: TalkAir };

export type TalkTickInput = {
  now: Date;
  lastTalkBreakAt: number;
  // A segment already rendered and queued for the next boundary (age anchor
  // from queue's `_pendingVoice`), or null. It has NOT aired, so
  // `lastTalkBreakAt` cannot see it (#1419). It blocks only while its queue life
  // outlives the row's window AND the row has a retry minute left (#1539); rows
  // with `minGapMs: 0` ignore it.
  pendingTalk: PendingTalk | null;
  // Resolved lazily, only for a row whose window is open and unfired.
  eligible: (kind: TalkKind) => boolean;
  // The open slot for an `opens: 'external'` row, or null.
  externalSlot: (kind: TalkKind) => string | null;
  // `djTalkOnlyBetweenTracks` (#1485), resolved by the caller through
  // broadcast/talk-air.ts. On, every row's `air` reads 'next-track' and the
  // pending-clip hold changes shape (see pendingHolds). A parameter, not a live
  // read, so the rule stays replayable.
  betweenTracksOnly?: boolean;
  fired: Partial<Record<TalkKind, string | null>>;
  logged: Partial<Record<TalkKind, string | null>>;
  slots?: readonly TalkSlot[];
};

// A held slot, with the log-once bookkeeping: the window's LAST minute always
// reports the lost chance; any other minute reports once per slot.
function waitPlan(row: TalkSlot, slot: string, slotKey: string, reason: TalkWaitReason, p: TalkTickInput): TalkPlan {
  const base = { kind: row.kind, act: 'wait' as const, slot, slotKey, reason };
  // A fill row standing down is normal, not an event; narrating it would bury
  // the lines that matter.
  if (row.role === 'fill') return { ...base, log: null, markLogged: null };
  if (!canRetry(row, slot, p.now.getMinutes())) {
    return { ...base, log: missedLine(row, slot, reason), markLogged: null };
  }
  // Once per slot, not once per tick.
  if (p.logged[row.kind] === slotKey) return { ...base, log: null, markLogged: null };
  return { ...base, log: standDownLine(row, slot, reason), markLogged: slotKey };
}

// Whether the pending clip's remaining queue life reaches PAST this row's window
// close. A clip expiring inside the window is dropped by the queue first, so it
// can't be why the row never speaks (#1539). Equality favours the scheduled row;
// queue still owns the stale drop. Only asked of a row that can retry, so
// `Number(slot)` is a real opening minute.
function pendingOutlivesWindow(row: TalkSlot, slot: string, pending: PendingTalk, nowMs: number): boolean {
  const windowClose = new Date(nowMs);
  windowClose.setMinutes(windowEndMinute(row, Number(slot)) + 1, 0, 0);
  const windowRemainingMs = Math.max(0, windowClose.getTime() - nowMs);
  return pendingVoiceValidForMs(pending.queuedAt, nowMs) > windowRemainingMs;
}

// Whether a rendered clip waiting for a boundary holds this row this minute.
// Two rules, because the switch changes what the clip is to the row.
//
// OFF (#1419 + #1539): the clip is unheard talk, so it counts against the QUIET
// GAP only, bounded at both ends so a hold never costs a row its window.
//
// ON (#1485 FR 5b): the clip is a RESOURCE, not a courtesy. Every row now
// defers, and `queue._pendingVoice` keeps exactly ONE deferred segment — a
// second one replaces the first — so a row firing while a clip waits would not
// stack a break, it would silently delete a rendered segment that has already
// been paid for in tokens and TTS. That is cancel, not postpone. So the hold
// applies to every row regardless of `minGapMs`, and it is NOT released on the
// window's last minute the way the gap-shaped hold is: the last-minute release
// exists to trade a stacked break for a lost slot, and with the constraint on
// the trade is not available — taking the minute costs the other segment
// instead. A row held out of its whole window logs `missed`, which is the
// honest report, and the boundary the clip is waiting for is usually a track
// away. Gating the SECOND segment here rather than queueing it in the queue is
// also gate-before-generation: a postponed row writes no script at all.
//
// One row is covered by that ON rule for a reason that does not apply to it:
// the jingle rotate (#1619) never writes `_pendingVoice` — it hands a clip that
// is already on disk to `jingle-now.txt` — so firing it could not delete a
// rendered segment. For that row the hold is COURTESY, not resource protection:
// don't stack a stinger in front of a segment that is about to air. Keeping it
// costs nothing (the count keeps counting, the next minute is another chance)
// and dropping the row out of the rule would be the collision the table was
// asked to arbitrate, so the rule stays uniform and this note stays here.
function pendingHolds(
  row: TalkSlot, slot: string, minute: number, pending: PendingTalk, p: TalkTickInput,
): boolean {
  if (p.betweenTracksOnly) return pendingVoiceValidForMs(pending.queuedAt, p.now.getTime()) > 0;
  if (row.minGapMs === 0) return false;
  // A row with no scheduled minutes ('any') cannot lose a chance by waiting —
  // the next tick it is sampled on is another one. The #1539 bound exists
  // ONLY to stop a hold turning a postpone into a cancel on a row with a
  // finite window, and there is nothing here to cancel, so the hold is
  // unbounded and the row simply waits for the clip to reach air. The bounded
  // form would be strictly wrong for such a row: every minute is its own
  // one-minute window, so `canRetry` is false on all of them and the row would
  // never be held at all — which for the jingle rotate (#1619) is exactly the
  // collision the table was asked to arbitrate.
  if (row.opens === 'any') return pendingVoiceValidForMs(pending.queuedAt, p.now.getTime()) > 0;
  return canRetry(row, slot, minute)
    && pendingOutlivesWindow(row, slot, pending, p.now.getTime());
}

// One row's decision, or null for nothing to do (outside the window, already
// spoken, ineligible). Silent by design. Arbitration is NOT here: this answers
// "would this row like the minute?"; talkTickPlan resolves contention.
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
  // Checked before the gap because it is the more specific reason. The hold is
  // bounded twice so postpone never becomes cancel (#1539): see pendingHolds.
  const pending = p.pendingTalk;
  if (pending && pendingHolds(row, slot, minute, pending, p)) {
    return waitPlan(row, slot, slotKey, { held: 'pending', pendingKind: pending.kind }, p);
  }
  const gap = talkGap({ nowMs: p.now.getTime(), lastTalkBreakAt: p.lastTalkBreakAt, needMs: row.minGapMs });
  // The switch forces EVERY row onto the boundary, the hourly check included.
  const air: TalkAir = p.betweenTracksOnly ? 'next-track' : row.air;
  if (gap.clear) return { kind: row.kind, act: 'fire', slot, slotKey, gap, air };
  return waitPlan(row, slot, slotKey, { held: 'gap', gap }, p);
}

// Everything this minute has to do, in dispatch order. Rows with nothing to do
// are absent rather than present-and-skipped.
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

  // Slot rows first; fill rows are only PLANNED if no slot row wanted the
  // minute — firing OR waiting, since a filler that speaks resets the quiet gap
  // and pushes the waiting row's retry out. "Wants the minute" is deliberately
  // narrower than "has an open window": with ten-minute windows the slot rows
  // cover 50 of 60 minutes, so deferring to open windows would switch the
  // director off rather than stand it down. Two passes rather than a filter, so
  // a contested minute never consults the filler's own gates.
  const out = planOf('slot');
  if (!out.length) out.push(...planOf('fill'));
  // Stable: equal priorities keep table order.
  out.sort((a, b) => (a.row.priority - b.row.priority) || (a.index - b.index));
  const contenders = out;

  // ONE TALKER PER MINUTE (#310). Windows overlap on purpose and the overlap is
  // resolved here; the loser waits inside its own window rather than losing the
  // slot (#1419). A row yields only to a row that is FIRING, never to one merely
  // open — yielding to an open-but-blocked row would let it sit on its whole
  // window starving everything below.
  let speaker: TalkKind | null = null;
  return contenders.map(({ row, plan }) => {
    if (plan.act !== 'fire') return plan;
    if (!speaker) { speaker = row.kind; return plan; }
    return waitPlan(row, plan.slot, plan.slotKey, { held: 'yield', to: speaker }, p);
  });
}
