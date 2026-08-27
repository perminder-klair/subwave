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
// them. The other rows carry the same fields — with PR-1 values that make them
// no-ops — so turning them on later is a table edit with a test diff, not a
// rewrite.
//
// Pure and I/O-free (a `Date`, two counters and two injected resolvers in;
// plans out) so scripts/talk-scheduler.test.ts can walk an hour minute by minute
// without a scheduler, a clock or a station.

import {
  BANTER_SLOTS, BANTER_WINDOW_MINUTES, BANTER_MIN_GAP_MS,
} from './banter-policy.js';

// ---------------------------------------------------------------------------
// THE SLOT TABLE
// ---------------------------------------------------------------------------

export type TalkKind = 'hourly' | 'programme' | 'banter' | 'station-id';

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

export type TalkSlot = {
  kind: TalkKind;
  // Minutes at which a window OPENS, or 'external' for a row whose placement is
  // computed elsewhere (programme beats, which resolve on the station clock via
  // programme.dueBeat()). The caller supplies external slots through the
  // `externalSlot` resolver.
  opens: readonly number[] | 'external';
  // How long a window stays open for, in minutes. 1 means "this minute only",
  // which is exactly the old fixed-instant cron.
  windowMinutes: number;
  // Minimum quiet gap since the last STANDALONE talk break before this row may
  // fire. 0 disables the check (the gap is then trivially clear), which is what
  // every row except banter carries today.
  minGapMs: number;
  air: TalkAir;
  // Dispatch order within a tick. PR 1 has NO arbitration — nothing loses a
  // slot to anything — so this only sequences the rows that happen to come due
  // together, and by construction only `programme` can co-occur with another
  // row (the fixed windows :00 / :15,:30,:45 / :20-:29,:50-:59 are disjoint).
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

// Rows in priority order. The values below are deliberately the ones that
// reproduce today's schedule EXACTLY — windows of 1 minute and `minGapMs: 0`
// everywhere banter isn't. Widening them is a behaviour change and belongs in
// its own PR (#1500, PR 2), where the frequency ladder also has to start
// answering per-SLOT rather than per-minute: shouldFire('stationId') currently
// tests `m === 45` / `[15,30,45].includes(m)`, so a retry minute inside a wider
// ident window would read as no slot at all. Banter already did that migration
// (dj-gate asks banterSlot(m)); nothing else has.
export const TALK_SLOTS: readonly TalkSlot[] = [
  // Top of the hour: the DJ checks in. Note the SESSION ROLL that used to share
  // this cron is not a row — it is unconditional and runs before any of this
  // (see scheduler.talkTick), because a muted or empty station must still roll
  // its session, plan the episode and settle a pending handoff.
  {
    kind: 'hourly',
    opens: [0],
    windowMinutes: 1,
    minGapMs: 0,
    air: 'immediate',
    priority: 1,
    clock: 'process',
    stride: 1,
    oneFirePerSlot: true,
  },
  // Programme beats — the feature mid-hour and the outro in the final minutes
  // of the show's last hour, both placed on the station clock by
  // programme.dueBeat(). Gating lives in programme.ts; this row only says when
  // to ask.
  {
    kind: 'programme',
    opens: 'external',
    windowMinutes: 1,
    minGapMs: 0,
    air: 'immediate',
    priority: 2,
    clock: 'station',
    stride: 5,
    oneFirePerSlot: false,
  },
  // Guest-show banter — the one row that already has a real window and a real
  // gap, because #1419 forced them. Its numbers keep their reasoning in
  // banter-policy.ts and are imported rather than restated.
  {
    kind: 'banter',
    opens: BANTER_SLOTS,
    windowMinutes: BANTER_WINDOW_MINUTES,
    minGapMs: BANTER_MIN_GAP_MS,
    air: 'immediate',
    priority: 2,
    clock: 'process',
    stride: 1,
    oneFirePerSlot: true,
  },
  // Station idents. Candidate minutes are :15/:30/:45 — deliberately NOT :00,
  // which the hourly check owns; firing both there stacked two voice segments
  // back to back (#310). The frequency rung narrows the three to one or two.
  {
    kind: 'station-id',
    opens: [15, 30, 45],
    windowMinutes: 1,
    minGapMs: 0,
    air: 'next-track',
    priority: 3,
    clock: 'process',
    stride: 1,
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

// `lastTalkBreakAt` is 0 when nothing has aired yet (a fresh boot), which reads
// as an infinite gap — correct: there is no break to stack onto. `needMs: 0`
// makes every gap clear, which is how a row opts out of the check entirely.
export function talkGap(p: { nowMs: number; lastTalkBreakAt: number; needMs: number }): TalkGap {
  const sinceMs = p.lastTalkBreakAt > 0 ? p.nowMs - p.lastTalkBreakAt : Infinity;
  return { clear: sinceMs >= p.needMs, sinceMs, needMs: p.needMs };
}

function slotLabel(row: TalkSlot, slot: string): string {
  return row.opens === 'external' ? slot : `:${slot}`;
}

function endLabel(row: TalkSlot, slot: string): string {
  return row.opens === 'external' ? slot : `:${windowEndMinute(row, Number(slot))}`;
}

function sinceLabel(gap: TalkGap): string {
  return Number.isFinite(gap.sinceMs) ? `${Math.round(gap.sinceMs / 1000)}s` : 'never';
}

// The stand-down line: the reason AND the numbers behind it, so this class of
// scheduling collision is visible in the booth log instead of being inferred
// from an absence. Logged once per slot by the caller (a per-minute tick would
// otherwise repeat it for every minute of the window).
export function standDownLine(row: TalkSlot, slot: string, gap: TalkGap): string {
  return `[${row.kind}] stood down at ${slotLabel(row, slot)} — last standalone talk ${sinceLabel(gap)} ago, `
    + `minimum gap ${Math.round(gap.needMs / 1000)}s (retrying until ${endLabel(row, slot)})`;
}

// The window closed unfired. Carries the gap numbers too, because this is the
// only line an operator gets when the very last minute of a window is the first
// one to be blocked.
export function missedLine(row: TalkSlot, slot: string, gap: TalkGap): string {
  return `[${row.kind}] slot ${slotLabel(row, slot)} missed — last standalone talk ${sinceLabel(gap)} ago, `
    + `minimum gap ${Math.round(gap.needMs / 1000)}s never cleared before ${endLabel(row, slot)}`;
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
  // In the window, eligible, but the quiet gap hasn't elapsed. `log` is the one
  // line to write (null when this slot has already reported) and `markLogged`
  // is what the caller should remember so the next minute stays quiet.
  | { kind: TalkKind; act: 'wait'; slot: string; slotKey: string; gap: TalkGap; log: string | null; markLogged: string | null }
  // Air it. The caller claims `slotKey` BEFORE awaiting the segment.
  | { kind: TalkKind; act: 'fire'; slot: string; slotKey: string; gap: TalkGap };

export type TalkTickInput = {
  now: Date;
  lastTalkBreakAt: number;
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

// One row's decision, or null for "nothing to do" — outside the window, already
// spoken, or not eligible this minute. Silent by design: a per-minute tick that
// narrated every ineligible minute would bury the booth log.
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
  const gap = talkGap({ nowMs: p.now.getTime(), lastTalkBreakAt: p.lastTalkBreakAt, needMs: row.minGapMs });
  if (gap.clear) return { kind: row.kind, act: 'fire', slot, slotKey, gap };
  // The window's last minute is the chance being LOST, so it says so rather
  // than promising a retry that can't happen — and it carries the numbers,
  // because it is the only line an operator gets when the last minute is also
  // the first one to be blocked.
  if (row.opens !== 'external' && minute === windowEndMinute(row, Number(slot))) {
    return { kind: row.kind, act: 'wait', slot, slotKey, gap, log: missedLine(row, slot, gap), markLogged: null };
  }
  // Once per slot, not once per tick: the stand-down used to be a bare
  // `return`, which is why a starved hour left nothing in the log to explain
  // itself (#1419).
  if (p.logged[row.kind] === slotKey) {
    return { kind: row.kind, act: 'wait', slot, slotKey, gap, log: null, markLogged: null };
  }
  return { kind: row.kind, act: 'wait', slot, slotKey, gap, log: standDownLine(row, slot, gap), markLogged: slotKey };
}

// Everything this minute has to do, in dispatch order. Rows that have nothing
// to do are absent rather than present-and-skipped, so the caller's loop is the
// list of things that actually happen.
export function talkTickPlan(p: TalkTickInput): TalkPlan[] {
  const rows = p.slots ?? TALK_SLOTS;
  const out: { plan: TalkPlan; priority: number; index: number }[] = [];
  rows.forEach((row, index) => {
    const plan = talkSlotPlan(row, p);
    if (plan) out.push({ plan, priority: row.priority, index });
  });
  // Stable: equal priorities keep table order, so the table itself stays the
  // one place the running order is written down.
  out.sort((a, b) => (a.priority - b.priority) || (a.index - b.index));
  return out.map(o => o.plan);
}
