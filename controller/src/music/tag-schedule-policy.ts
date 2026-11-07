// Scheduled tagging (#2282): whether the daily tagger run starts now. Pure, so
// every branch is pinned by scripts/tag-schedule.test.ts; broadcast/tag-schedule.ts
// gathers the inputs and acts on the answer.
//
// The questions are asked in order, cheapest first, and the impure tick stops
// at the first one that says no, so a station that is off, or already ran
// today, never touches Navidrome or Icecast:
//
//   1. scheduleDue      setting + station clock + the last station day used
//   2. a run is going   wait: retried on the next tick, the day not used
//   3. no steps on      skip: the day is used, nothing would run
//   4. pendingWork      library.db counts + Navidrome's own song count
//   5. Navidrome scans  wait: its count is still moving
//   6. quiet times      wait: the existing quiet gate (quietGateDecision)
//
// "Skip" spends the station day: the run is daily, so a library with nothing
// new at the set time waits for tomorrow's. "Wait" does not: the run starts on
// the first tick the hold lifts, the same station day. A hold still standing at
// the station's midnight lapses that day; the tick logs it.
//
// The day may be caught up: a controller that was down at the set time starts
// the run on its first tick after it, the same station day. The time is a
// floor, not a window.
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

export type PendingWork =
  | { pending: true; reason: 'untagged' | 'new-in-navidrome' | 'unknown' }
  | { pending: false };

/**
 * Whether there is anything for the run to tag.
 *
 * library.db alone cannot answer it: a track added to Navidrome has no row
 * until a walk finds it, and the walk is the run itself. So the station's own
 * rows answer for tracks it already knows, and Navidrome's song count, one
 * cheap call, answers for the ones it doesn't: more songs there than rows here
 * means new music. Fewer (a removal) is not work for the tagger.
 *
 * An unknown count fails OPEN: the run starts and its own walk finds out, which
 * costs one walk on a night Navidrome could not be asked. Failing closed would
 * mean a station whose Navidrome never reports `count` never tags on its own.
 * The comparison misses a night where removals and additions cancel exactly;
 * the next addition catches it.
 */
export function pendingWork(c: WorkCounts): PendingWork {
  if (c.dbUntagged != null && c.dbUntagged > 0) return { pending: true, reason: 'untagged' };
  if (c.navidromeCount == null || c.dbRows == null || c.dbUntagged == null) {
    return { pending: true, reason: 'unknown' };
  }
  if (c.navidromeCount > c.dbRows) return { pending: true, reason: 'new-in-navidrome' };
  return { pending: false };
}

/** A label for the booth log and the admin card. */
export function pendingWorkText(c: WorkCounts, p: PendingWork): string {
  if (!p.pending) return 'nothing untagged';
  if (p.reason === 'untagged') return `${c.dbUntagged} untagged`;
  if (p.reason === 'new-in-navidrome') {
    return `${(c.navidromeCount ?? 0) - (c.dbRows ?? 0)} new in Navidrome`;
  }
  return 'library count unknown';
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
}

export const EMPTY_TAG_SCHEDULE_RECORD: TagScheduleRecord = {
  version: 1, lastDay: null, startedAt: null, outcome: null, detail: null, at: null, runLogId: null,
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max = 2000): string | null =>
  typeof v === 'string' && v.length <= max ? v : null;
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;

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
  };
}
