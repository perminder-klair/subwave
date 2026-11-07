// Scheduled tagging (#2282): every decision the daily tagger run makes. Pure,
// so every branch is pinned by scripts/tag-schedule.test.ts; broadcast/
// tag-schedule.ts only gathers the inputs this module asks for and acts on its
// answer.
//
// scheduleGate() asks its questions in order, cheapest first, and stops at the
// first that says no, so a station that is off, or already ran today, never
// touches Navidrome or Icecast. It names the next input it needs ('need-counts',
// 'need-listeners') instead of taking a callback, and the tick calls it again
// once it has that input:
//
//   1. scheduleDue      setting + station clock + the last station day used
//   2. a run is going   wait: retried on the next tick, the day not used
//   3. no steps on      skip: the day is used, nothing would run
//   4. Navidrome scans  wait: its count is still moving, so it says nothing yet
//   5. pendingWork      library.db counts + Navidrome's song count
//   6. quiet times      wait: the existing quiet gate (quietGateDecision)
//
// "Skip" spends the station day: the run is daily, so a library with nothing
// new at the set time waits for tomorrow's. "Wait" does not: the run starts on
// the first tick the hold lifts, the same station day. A hold still standing at
// the station's midnight lapses that day (lapsedHold).
//
// The day may be caught up: a controller that was down at the set time starts
// the run on its first tick after it, the same station day. The time is a
// floor, not a window.
import { quietGateDecision, type QuietState } from './analyze-quiet-pure.js';
import {
  TAGGER_AUTO_STEP_KEYS,
  TAGGER_AUTO_TIME_RE,
  type TaggerAutoSettings,
  type TaggerAutoSteps,
} from '../schemas/settings.js';

/** Minutes after the station's midnight for a stored `HH:MM`, or null. */
export function scheduleMinuteOfDay(time: string): number | null {
  if (!TAGGER_AUTO_TIME_RE.test(time)) return null;
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export type ScheduleDue = 'off' | 'not-due' | 'done-today' | 'due';

/**
 * Whether today's scheduled run is owed. `today` is the station-clock date
 * (`YYYY-MM-DD`) and `minuteOfDay` the station-clock minute, so DST needs no
 * case of its own: on a spring-forward night 02:30 never happens and 03:00 is
 * already past it, and on a fall-back night the second 02:30 finds the day
 * used.
 */
export function scheduleDue(input: {
  auto: Pick<TaggerAutoSettings, 'mode' | 'time'>;
  today: string;
  minuteOfDay: number;
  lastDay: string | null;
}): ScheduleDue {
  const { auto, today, minuteOfDay, lastDay } = input;
  if (auto.mode !== 'daily') return 'off';
  if (lastDay === today) return 'done-today';
  const at = scheduleMinuteOfDay(auto.time);
  // An unreadable time never reaches here (load() repairs it), but if one did
  // the schedule stays quiet rather than firing at midnight.
  if (at == null) return 'off';
  return minuteOfDay >= at ? 'due' : 'not-due';
}

/** Which run the steps describe, or null when none is on. Reconcile alone is
 *  the walk-and-prune run, as the Run tab sends it. */
export function scheduledRunKind(steps: TaggerAutoSteps): 'tag' | 'reconcile' | null {
  const on = TAGGER_AUTO_STEP_KEYS.filter((k) => steps[k]);
  if (!on.length) return null;
  if (on.length === 1 && on[0] === 'reconcile') return 'reconcile';
  return 'tag';
}

export interface WorkCounts {
  /** library.db rows with no moods yet (known to the station, not tagged). */
  dbUntagged: number | null;
  /** Every library.db row. */
  dbRows: number | null;
  /** Navidrome's own song count (getScanStatus `count`). */
  navidromeCount: number | null;
}

export interface WorkScope {
  /** The run tags moods: only then is an untagged row work it can close. */
  tagMoods: boolean;
  /** Navidrome's count when the last successful scheduled run started its
   *  walk (TagScheduleRecord.walkedCount), or null before the first one. */
  walkedCount: number | null;
}

export type PendingWork =
  | { pending: true; reason: 'untagged' | 'new-in-navidrome' | 'unknown'; amount: number | null }
  | { pending: false };

/**
 * Whether the run has anything it can do. Each answer is something the run
 * itself closes, so a "yes" cannot stand night after night:
 *
 *   - Untagged rows count only when the run tags moods. With "Tag moods" off
 *     no run of this schedule tags them, so they never count.
 *   - New music is Navidrome's song count above `walkedCount`, the count the
 *     last successful scheduled run started its walk from. library.db alone
 *     cannot see a new track (it has no row until a walk finds it), and
 *     Navidrome's count against library.db's rows never settles: the walk
 *     drops blocklisted songs and station-archive mixdowns that Navidrome
 *     still counts, so one blocklisted song would read as "1 new" forever.
 *     Every run kind walks, so any run closes this gap; a song the walk drops
 *     is part of the count the next baseline starts from.
 *   - Before the first scheduled run there is no baseline, and library.db's
 *     row count stands in once. A station whose walk drops songs runs that
 *     first night, and the baseline it leaves stops the repeat.
 *
 * Fewer songs than the baseline (a removal) is not work; scheduleGate lowers
 * the baseline to it so a later addition still counts. An unknown count fails
 * OPEN: the run starts and its own walk finds out. Failing closed would mean a
 * station whose Navidrome never reports `count` never tags on its own. The
 * comparison misses a night where removals and additions cancel exactly; the
 * next addition catches it.
 */
export function pendingWork(c: WorkCounts, scope: WorkScope): PendingWork {
  if (scope.tagMoods) {
    if (c.dbUntagged == null) return { pending: true, reason: 'unknown', amount: null };
    if (c.dbUntagged > 0) return { pending: true, reason: 'untagged', amount: c.dbUntagged };
  }
  const base = scope.walkedCount ?? c.dbRows;
  if (c.navidromeCount == null || base == null) return { pending: true, reason: 'unknown', amount: null };
  if (c.navidromeCount > base) {
    return { pending: true, reason: 'new-in-navidrome', amount: c.navidromeCount - base };
  }
  return { pending: false };
}

/** A label for the booth log and the admin card. */
export function pendingWorkText(p: PendingWork): string {
  if (!p.pending) return 'nothing new or untagged';
  if (p.reason === 'untagged') return `${p.amount} untagged`;
  if (p.reason === 'new-in-navidrome') return `${p.amount} new in Navidrome`;
  return 'library count unknown';
}

/** The baseline after a reading: a removal lowers it, so a later addition is
 *  still seen as new. Never raised here; only a finished walk raises it. */
export function lowerBaseline(walkedCount: number | null, navidromeCount: number | null): number | null {
  if (walkedCount == null || navidromeCount == null) return walkedCount;
  return Math.min(walkedCount, navidromeCount);
}

export type HoldReason = 'busy' | 'scanning' | 'quiet';

export const HOLD_BUSY_TEXT = 'another tagger, analysis or reconcile run is going';
export const HOLD_SCANNING_TEXT = 'Navidrome is scanning its library';

export interface GateInput {
  auto: TaggerAutoSettings;
  today: string;
  minuteOfDay: number;
  lastDay: string | null;
  walkedCount: number | null;
  /** Read fresh for every call: the tick calls the gate again after each await. */
  running: boolean;
  /** Undefined until read; the gate asks for it ('need-counts'). */
  counts?: WorkCounts & { scanning: boolean | null };
  quiet: { enabled: boolean; minutes: number };
  /** Undefined until probed; the gate asks for it ('need-listeners'). */
  listeners?: number | null;
  quietState: QuietState;
  nowMs: number;
}

export type Gate =
  /** Off, not yet due, or the day already used: any standing hold is cleared. */
  | { kind: 'idle' }
  | { kind: 'need-counts' }
  | { kind: 'need-listeners' }
  | { kind: 'hold'; reason: HoldReason; text: string; quietState: QuietState }
  /** The day is used. `walkedCount` is the baseline to keep. */
  | { kind: 'skip'; detail: string; walkedCount: number | null }
  | {
    kind: 'start';
    run: 'tag' | 'reconcile';
    detail: string;
    quietState: QuietState;
    walkedCount: number | null;
    /** Navidrome's count now, before the walk: the next baseline if it succeeds. */
    startCount: number | null;
  };

const NO_QUIET: QuietState = { quietSince: null };

/** The one decision: whether the scheduled run starts now, and if not, why. */
export function scheduleGate(i: GateInput): Gate {
  const due = scheduleDue({ auto: i.auto, today: i.today, minuteOfDay: i.minuteOfDay, lastDay: i.lastDay });
  if (due !== 'due') return { kind: 'idle' };
  // A hold that is no longer about quiet starts the quiet clock afresh.
  if (i.running) return { kind: 'hold', reason: 'busy', text: HOLD_BUSY_TEXT, quietState: NO_QUIET };

  const run = scheduledRunKind(i.auto.steps);
  if (!run) return { kind: 'skip', detail: 'no steps are switched on', walkedCount: i.walkedCount };

  if (!i.counts) return { kind: 'need-counts' };
  // Before the work check: a scan's count is still moving, and judging it now
  // could spend the day on a library that is half-way through growing.
  if (i.counts.scanning === true) {
    return { kind: 'hold', reason: 'scanning', text: HOLD_SCANNING_TEXT, quietState: NO_QUIET };
  }
  const walkedCount = lowerBaseline(i.walkedCount, i.counts.navidromeCount);
  const work = pendingWork(i.counts, { tagMoods: run === 'tag' && i.auto.steps.tagMoods, walkedCount });
  const workText = pendingWorkText(work);
  if (!work.pending) return { kind: 'skip', detail: workText, walkedCount };

  let quietState = NO_QUIET;
  if (i.quiet.enabled) {
    if (i.listeners === undefined) return { kind: 'need-listeners' };
    const d = quietGateDecision(i.quietState, {
      enabled: true, count: i.listeners, now: i.nowMs, quietAfterMs: i.quiet.minutes * 60_000,
    });
    quietState = d.state;
    if (!d.proceed) {
      const why = i.listeners && i.listeners > 0 ? `${i.listeners} listening` : `the ${i.quiet.minutes}-minute quiet window`;
      return { kind: 'hold', reason: 'quiet', text: `quiet times (${why})`, quietState };
    }
  }

  const limitText = i.auto.limit > 0 ? `limit ${i.auto.limit}` : 'all untagged';
  const detail = run === 'reconcile' ? `reconcile only, ${workText}` : `${workText}, ${limitText}`;
  return { kind: 'start', run, detail, quietState, walkedCount, startCount: i.counts.navidromeCount };
}

/** A hold that stood until the station's midnight: the day it was for is
 *  recorded as missed, unless that day was used some other way. */
export function lapsedHold(
  waiting: { day: string; text: string } | null,
  today: string,
  lastDay: string | null,
): { day: string; text: string; record: boolean } | null {
  if (!waiting || waiting.day === today) return null;
  return { day: waiting.day, text: waiting.text, record: lastDay !== waiting.day };
}

/** How a scheduled run ended, as broadcast/tagger.ts reports it (TaggerRunEnd). */
export interface ScheduledRunEnd {
  outcome: 'ok' | 'failed' | 'stopped';
  error: string | null;
  signal: string | null;
  exitCode: number | null;
  holds: string[];
  runLogId: string | null;
}

/**
 * What the record and the booth log say when a scheduled run ends. A hold
 * outranks the exit code: the run finished, but the operator owes it an
 * answer. Only a clean finish raises the baseline, to the count the run
 * started from: a song added during the walk is then still new tomorrow.
 * A failure is not retried; tomorrow is the retry.
 */
export function scheduledRunEnded(
  rec: Pick<TagScheduleRecord, 'startCount' | 'walkedCount'>,
  end: ScheduledRunEnd,
): { patch: Partial<TagScheduleRecord>; message: string } {
  const base = { runLogId: end.runLogId };
  if (end.holds.length) {
    const more = end.holds.length > 1 ? ` (+${end.holds.length - 1} more)` : '';
    const detail = `${end.holds[0]}${more}`;
    return {
      patch: { ...base, outcome: 'held', detail },
      message: `Scheduled tagging held for the operator: ${detail}. An unattended run never confirms; answer it with a manual run`,
    };
  }
  if (end.outcome === 'ok') {
    return {
      patch: { ...base, outcome: 'ok', detail: null, walkedCount: rec.startCount ?? rec.walkedCount },
      message: 'Scheduled tagging finished',
    };
  }
  if (end.outcome === 'stopped') {
    const detail = end.error ?? (end.signal ? `stopped (${end.signal})` : 'stopped');
    return { patch: { ...base, outcome: 'stopped', detail }, message: `Scheduled tagging stopped: ${detail}` };
  }
  const detail = end.error ?? (end.exitCode != null ? `exit ${end.exitCode}` : 'failed');
  return {
    patch: { ...base, outcome: 'failed', detail },
    message: `Scheduled tagging failed: ${detail}. Not retried; the next run is tomorrow`,
  };
}

// ---------------------------------------------------------------------------
// The record the scheduled job keeps of itself, `state/tagger-schedule.json`.
// The job is its only writer, and it survives a restart so the admin card can
// say what the last scheduled run did and the day is never run twice.

export const TAG_SCHEDULE_OUTCOMES = [
  'running', 'ok', 'failed', 'stopped', 'held', 'skipped', 'missed', 'interrupted',
] as const;
export type TagScheduleOutcome = (typeof TAG_SCHEDULE_OUTCOMES)[number];

export interface TagScheduleRecord {
  version: 1;
  /** Station-clock date the schedule last used (started, skipped or missed). */
  lastDay: string | null;
  /** When the last scheduled run started; null when that day did not start one. */
  startedAt: string | null;
  outcome: TagScheduleOutcome | null;
  /** Why, in words: the skip reason, the failure, the hold. */
  detail: string | null;
  /** When `outcome` was last set. */
  at: string | null;
  runLogId: string | null;
  /** Navidrome's song count when the last scheduled run started. */
  startCount: number | null;
  /** The new-music baseline (pendingWork): Navidrome's count when the last
   *  successful scheduled run started its walk, lowered by any removal since. */
  walkedCount: number | null;
}

export const EMPTY_TAG_SCHEDULE_RECORD: TagScheduleRecord = {
  version: 1,
  lastDay: null,
  startedAt: null,
  outcome: null,
  detail: null,
  at: null,
  runLogId: null,
  startCount: null,
  walkedCount: null,
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max = 2000): string | null =>
  typeof v === 'string' && v.length <= max ? v : null;
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
const countOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** Lenient read: a missing, corrupt or foreign file is "never ran". Never throws. */
export function normalizeTagScheduleRecord(raw: unknown): TagScheduleRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_TAG_SCHEDULE_RECORD };
  const r = raw as Record<string, unknown>;
  const lastDay = typeof r.lastDay === 'string' && DAY_RE.test(r.lastDay) ? r.lastDay : null;
  const outcome = (TAG_SCHEDULE_OUTCOMES as readonly unknown[]).includes(r.outcome)
    ? (r.outcome as TagScheduleOutcome)
    : null;
  return {
    version: 1,
    lastDay,
    startedAt: isoOrNull(r.startedAt),
    outcome,
    detail: str(r.detail),
    at: isoOrNull(r.at),
    runLogId: str(r.runLogId, 200),
    startCount: countOrNull(r.startCount),
    walkedCount: countOrNull(r.walkedCount),
  };
}
