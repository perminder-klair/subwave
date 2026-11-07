// Scheduled tagging (#2282): the impure half. One tick, registered in
// broadcast/scheduler.ts every five minutes, asks music/tag-schedule-policy.ts
// whether the day's run is owed and, when it is, starts it through the same
// startTagger/startReconcile the Run tab's Start reaches.
//
// What it promises, each on purpose:
//   - Off by default (settings.tagger.auto.mode), and an off schedule costs a
//     settings read: no Navidrome call, no listener probe, no file read.
//   - At most one scheduled start per station day, kept in
//     `state/tagger-schedule.json`, which only this module writes, so a
//     restart neither repeats the day nor forgets what the last run did.
//   - It never starts over a run already going (the one single-flight slot,
//     tagger.running), re-checked after its own awaits.
//   - Quiet times hold the START: with quiet-only analysis on, the run waits
//     for the existing quiet gate (quietGateDecision over probeListenerCount).
//     Once running, only the analysis step pauses per track, as for any run.
//   - An unattended run never answers a replaced-file hold: it sends neither
//     confirmReplaced nor acceptReplaced, and a hold is said in the booth log.
//   - A failed run (an LLM outage, the token cap) is logged and not retried.
//     The default provider is a slow homelab Ollama; tomorrow is the retry.
//   - Nothing here throws at the scheduler's expense.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { STATE_DIR } from '../config.js';
import { createSerialFileWriter } from '../util/atomic-file.js';
import { quietGateDecision, type QuietState } from '../music/analyze-quiet-pure.js';
import {
  EMPTY_TAG_SCHEDULE_RECORD,
  normalizeTagScheduleRecord,
  pendingWork,
  pendingWorkText,
  scheduleDue,
  scheduledRunKind,
  type TagScheduleOutcome,
  type TagScheduleRecord,
  type WorkCounts,
} from '../music/tag-schedule-policy.js';
import type { TaggerAutoSettings } from '../schemas/settings.js';
import type { TaggerRunEnd } from './tagger.js';

export const TAG_SCHEDULE_FILE = 'tagger-schedule.json';

export interface TagScheduleDeps {
  auto: () => TaggerAutoSettings;
  /** Station-clock date and minute for `now`. */
  clock: (now: Date) => { today: string; minuteOfDay: number };
  running: () => boolean;
  counts: () => Promise<WorkCounts & { scanning: boolean | null }>;
  quiet: () => { enabled: boolean; minutes: number };
  probeListeners: () => Promise<number | null>;
  start: (kind: 'tag' | 'reconcile', auto: TaggerAutoSettings, onExit: (end: TaggerRunEnd) => void) => void;
  readRecord: () => Promise<unknown>;
  writeRecord: (rec: TagScheduleRecord) => Promise<void>;
  log: (message: string) => void;
}

/** What the admin card shows: the record, plus a hold still standing today. */
export interface TagScheduleView extends TagScheduleRecord {
  waiting: string | null;
}

type HoldReason = 'busy' | 'scanning' | 'quiet';

export function createTagSchedule(deps: TagScheduleDeps) {
  let record: TagScheduleRecord | null = null;
  // A scheduled run this process started and has not heard the end of.
  let activeRun = false;
  // A hold standing on a due day; logged once per reason, lapses at midnight.
  let waiting: { day: string; reason: HoldReason; text: string } | null = null;
  let quiet: QuietState = { quietSince: null };
  let ticking = false;

  async function load(): Promise<TagScheduleRecord> {
    if (record) return record;
    let raw: unknown = null;
    try { raw = await deps.readRecord(); } catch { raw = null; }
    record = normalizeTagScheduleRecord(raw);
    return record;
  }

  async function save(patch: Partial<TagScheduleRecord>, now: Date): Promise<void> {
    const base = record ?? { ...EMPTY_TAG_SCHEDULE_RECORD };
    record = { ...base, ...patch, version: 1, at: now.toISOString() };
    try {
      await deps.writeRecord(record);
    } catch (err: any) {
      // The in-memory record still holds the day for this process; only a
      // restart before the next good write could repeat it.
      deps.log(`Scheduled tagging: could not save ${TAG_SCHEDULE_FILE}: ${err?.message || err}`);
    }
  }

  function clearHold() {
    waiting = null;
    quiet = { quietSince: null };
  }

  function hold(day: string, reason: HoldReason, text: string) {
    if (!waiting || waiting.reason !== reason || waiting.day !== day) {
      deps.log(`Scheduled tagging waiting: ${text}`);
    }
    // A hold that is no longer about quiet starts the quiet clock afresh.
    if (reason !== 'quiet') quiet = { quietSince: null };
    waiting = { day, reason, text };
  }

  async function skip(day: string, detail: string, now: Date) {
    clearHold();
    deps.log(`Scheduled tagging skipped: ${detail}`);
    await save({ lastDay: day, startedAt: null, outcome: 'skipped', detail, runLogId: null }, now);
  }

  function onExit(end: TaggerRunEnd) {
    activeRun = false;
    const now = new Date();
    let outcome: TagScheduleOutcome;
    let detail: string | null;
    if (end.holds.length) {
      outcome = 'held';
      const more = end.holds.length > 1 ? ` (+${end.holds.length - 1} more)` : '';
      detail = `${end.holds[0]}${more}`;
      deps.log(`Scheduled tagging held for the operator: ${detail}. An unattended run never confirms; answer it with a manual run`);
    } else if (end.outcome === 'ok') {
      outcome = 'ok';
      detail = null;
      deps.log('Scheduled tagging finished');
    } else if (end.outcome === 'stopped') {
      outcome = 'stopped';
      detail = end.error ?? (end.signal ? `stopped (${end.signal})` : 'stopped');
      deps.log(`Scheduled tagging stopped: ${detail}`);
    } else {
      outcome = 'failed';
      detail = end.error ?? (end.exitCode != null ? `exit ${end.exitCode}` : 'failed');
      deps.log(`Scheduled tagging failed: ${detail}. Not retried; the next run is tomorrow`);
    }
    void save({ outcome, detail, runLogId: end.runLogId }, now);
  }

  async function tickInner(now: Date): Promise<void> {
    const rec = await load();
    // A run the record says is going, and this process never started, was
    // killed by the restart that started this process (recoverFromRestart).
    if (rec.outcome === 'running' && !activeRun) {
      deps.log('Scheduled tagging: the last scheduled run was interrupted by a controller restart');
      await save({ outcome: 'interrupted', detail: 'interrupted by a controller restart' }, now);
    }

    const auto = deps.auto();
    const { today, minuteOfDay } = deps.clock(now);

    if (waiting && waiting.day !== today) {
      const lapsed = waiting;
      clearHold();
      deps.log(`Scheduled tagging did not run on ${lapsed.day}: ${lapsed.text} all day`);
      if (record?.lastDay !== lapsed.day) {
        await save({ lastDay: lapsed.day, startedAt: null, outcome: 'missed', detail: lapsed.text, runLogId: null }, now);
      }
    }

    const due = scheduleDue({ auto, today, minuteOfDay, lastDay: record?.lastDay ?? null });
    if (due !== 'due') {
      clearHold();
      return;
    }
    if (deps.running()) return hold(today, 'busy', 'another tagger, analysis or reconcile run is going');

    const kind = scheduledRunKind(auto.steps);
    if (!kind) return skip(today, 'no steps are switched on', now);

    const counts = await deps.counts();
    const work = pendingWork(counts);
    const workText = pendingWorkText(counts, work);
    if (!work.pending) return skip(today, workText, now);
    if (counts.scanning === true) return hold(today, 'scanning', 'Navidrome is scanning its library');

    const q = deps.quiet();
    if (q.enabled) {
      const count = await deps.probeListeners();
      const d = quietGateDecision(quiet, {
        enabled: true, count, now: now.getTime(), quietAfterMs: q.minutes * 60_000,
      });
      quiet = d.state;
      if (!d.proceed) {
        const why = count && count > 0 ? `${count} listening` : `the ${q.minutes}-minute quiet window`;
        return hold(today, 'quiet', `quiet times (${why})`);
      }
    }

    // Re-check at the mutation boundary: the awaits above give a manual Start
    // time to take the slot.
    if (deps.running()) return hold(today, 'busy', 'another tagger, analysis or reconcile run is going');

    clearHold();
    const limitText = auto.limit > 0 ? `limit ${auto.limit}` : 'all untagged';
    const detail = kind === 'reconcile' ? `reconcile only, ${workText}` : `${workText}, ${limitText}`;
    await save({ lastDay: today, startedAt: now.toISOString(), outcome: 'running', detail, runLogId: null }, now);
    deps.log(`Scheduled tagging starting (${detail})`);
    activeRun = true;
    try {
      deps.start(kind, auto, onExit);
    } catch (err: any) {
      activeRun = false;
      const msg = err?.message || String(err);
      deps.log(`Scheduled tagging failed: could not start (${msg}). Not retried; the next run is tomorrow`);
      await save({ outcome: 'failed', detail: `could not start: ${msg}` }, now);
    }
  }

  return {
    /** One scheduler tick. Never throws; overlapping ticks are dropped. */
    async tick(now: Date = new Date()): Promise<void> {
      if (ticking) return;
      ticking = true;
      try {
        await tickInner(now);
      } catch (err: any) {
        deps.log(`Scheduled tagging check failed: ${err?.message || err}`);
      } finally {
        ticking = false;
      }
    },
    async view(): Promise<TagScheduleView> {
      const rec = await load();
      return { ...rec, waiting: waiting?.text ?? null };
    },
  };
}

/**
 * The Run tab's Start, as the schedule sends it: the saved limit (0 = all
 * untagged) and steps, vocal left to the setting, and never a replaced-file
 * answer (confirmReplaced / acceptReplaced), so an unattended run holds.
 */
export function scheduledTaggerOptions(auto: TaggerAutoSettings) {
  return {
    limit: auto.limit > 0 ? auto.limit : undefined,
    reconcile: auto.steps.reconcile,
    enrich: auto.steps.enrich,
    tagMoods: auto.steps.tagMoods,
    analyze: auto.steps.analyze,
  };
}

// ---------------------------------------------------------------------------
// The station's instance. The imports are lazy so the factory above stays
// testable without opening the library DB or reaching Navidrome.

const RECORD_PATH = path.join(STATE_DIR, TAG_SCHEDULE_FILE);
const writeRecordFile = createSerialFileWriter(RECORD_PATH);

async function liveCounts(): Promise<WorkCounts & { scanning: boolean | null }> {
  const library = await import('../music/library.js');
  const db = await import('../music/library-db.js');
  const subsonic = await import('../music/subsonic.js');
  let dbRows: number | null = null;
  let dbUntagged: number | null = null;
  try {
    await library.load();
    dbRows = db.trackCount();
    dbUntagged = Math.max(0, dbRows - db.countTagged());
  } catch { /* unknown: pendingWork fails open */ }
  const { scanning, count } = await subsonic.getScanSummary();
  return { dbRows, dbUntagged, navidromeCount: count, scanning };
}

let live: ReturnType<typeof createTagSchedule> | null = null;

async function liveSchedule() {
  if (live) return live;
  const settings = await import('../settings.js');
  const time = await import('../time.js');
  const { tagger, startTagger, startReconcile } = await import('./tagger.js');
  const { probeListenerCount } = await import('./listeners.js');
  const { quietOnlyEnabled, quietAfterMinutes } = await import('../music/analyze-quiet-pure.js');
  const { queue } = await import('./queue.js');
  live = createTagSchedule({
    auto: () => settings.get().tagger.auto,
    clock: (now) => {
      const p = time.zonedParts(now);
      return { today: time.zonedISODate(now), minuteOfDay: p.hour * 60 + p.minute };
    },
    running: () => tagger.running,
    counts: liveCounts,
    quiet: () => {
      const audio = settings.get()?.audio;
      return { enabled: quietOnlyEnabled(process.env.ANALYZE_QUIET_ONLY, audio), minutes: quietAfterMinutes(audio) };
    },
    probeListeners: probeListenerCount,
    start: (kind, auto, onExit) => {
      // Never a replaced-file answer: an unattended run holds and says so.
      if (kind === 'reconcile') {
        startReconcile({ onExit });
        return;
      }
      startTagger({ ...scheduledTaggerOptions(auto), onExit });
    },
    readRecord: async () => JSON.parse(await readFile(RECORD_PATH, 'utf8')),
    writeRecord: (rec) => writeRecordFile(`${JSON.stringify(rec, null, 2)}\n`),
    log: (message) => queue.log('scheduler', message),
  });
  return live;
}

export async function scheduledTagTick(): Promise<void> {
  try {
    await (await liveSchedule()).tick();
  } catch { /* the tick logs its own failures; wiring failures stay out of the cron */ }
}

export async function scheduledTagView(): Promise<TagScheduleView> {
  return (await liveSchedule()).view();
}
