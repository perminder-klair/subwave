// Scheduled tagging (#2282): the impure half. One tick, registered in
// broadcast/scheduler.ts every five minutes, gathers what
// music/tag-schedule-policy.ts `scheduleGate` asks for and acts on its answer,
// starting the run through the same startTagger/startReconcile the Run tab's
// Start reaches. Every decision (the order of the checks, the holds, the
// outcomes, the new-music baseline) is the policy module's; this file reads,
// writes and logs.
//
// What it promises, each on purpose:
//   - Off by default (settings.tagger.auto.mode), and an off schedule costs a
//     settings read: no Navidrome call, no listener probe, no file read.
//   - At most one scheduled start per station day, kept in
//     `state/tagger-schedule.json`, which only this module writes, so a
//     restart neither repeats the day nor forgets what the last run did.
//   - It never starts over a run already going (the one single-flight slot,
//     tagger.running). The gate is asked again after every await with a fresh
//     `running`, and the start follows the last answer with no await between,
//     so a manual Start cannot slip in: spawnChild sets tagger.running
//     synchronously, and the routes refuse a Start while it is set.
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
import { quietAfterMinutes, quietOnlyEnabled, type QuietState } from '../music/analyze-quiet-pure.js';
import {
  EMPTY_TAG_SCHEDULE_RECORD,
  lapsedHold,
  normalizeTagScheduleRecord,
  scheduleGate,
  scheduledRunEnded,
  type GateInput,
  type HoldReason,
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

  // The in-memory record changes synchronously, before the write is awaited,
  // so a caller that does not await still orders its change before anything
  // that follows it (the start below, and the run's own end).
  function save(patch: Partial<TagScheduleRecord>, now: Date): Promise<void> {
    const base = record ?? { ...EMPTY_TAG_SCHEDULE_RECORD };
    record = { ...base, ...patch, version: 1, at: now.toISOString() };
    return deps.writeRecord(record).catch((err: any) => {
      // The in-memory record still holds the day for this process; only a
      // restart before the next good write could repeat it.
      deps.log(`Scheduled tagging: could not save ${TAG_SCHEDULE_FILE}: ${err?.message || err}`);
    });
  }

  function clearHold() {
    waiting = null;
    quiet = { quietSince: null };
  }

  function onExit(end: TaggerRunEnd) {
    activeRun = false;
    const { patch, message } = scheduledRunEnded(record ?? EMPTY_TAG_SCHEDULE_RECORD, end);
    deps.log(message);
    void save(patch, new Date());
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

    const lapsed = lapsedHold(waiting, today, record?.lastDay ?? null);
    if (lapsed) {
      clearHold();
      deps.log(`Scheduled tagging did not run on ${lapsed.day}: ${lapsed.text} all day`);
      if (lapsed.record) {
        await save({ lastDay: lapsed.day, startedAt: null, outcome: 'missed', detail: lapsed.text, runLogId: null }, now);
      }
    }

    const input: GateInput = {
      auto,
      today,
      minuteOfDay,
      lastDay: record?.lastDay ?? null,
      walkedCount: record?.walkedCount ?? null,
      running: deps.running(),
      quiet: deps.quiet(),
      quietState: quiet,
      nowMs: now.getTime(),
    };
    // Each await below is followed by a fresh `running` and a fresh answer;
    // the start acts on the last answer with no await in between.
    let gate = scheduleGate(input);
    if (gate.kind === 'need-counts') {
      input.counts = await deps.counts();
      gate = scheduleGate({ ...input, running: deps.running() });
    }
    if (gate.kind === 'need-listeners') {
      input.listeners = await deps.probeListeners();
      gate = scheduleGate({ ...input, running: deps.running() });
    }

    switch (gate.kind) {
      case 'idle':
        clearHold();
        return;
      case 'need-counts':
      case 'need-listeners':
        // Unreachable: each input is supplied once above.
        return;
      case 'hold':
        if (!waiting || waiting.reason !== gate.reason || waiting.day !== today) {
          deps.log(`Scheduled tagging waiting: ${gate.text}`);
        }
        waiting = { day: today, reason: gate.reason, text: gate.text };
        quiet = gate.quietState;
        return;
      case 'skip':
        clearHold();
        deps.log(`Scheduled tagging skipped: ${gate.detail}`);
        await save({
          lastDay: today, startedAt: null, outcome: 'skipped', detail: gate.detail, runLogId: null,
          walkedCount: gate.walkedCount,
        }, now);
        return;
      case 'start': {
        clearHold();
        const saved = save({
          lastDay: today, startedAt: now.toISOString(), outcome: 'running', detail: gate.detail, runLogId: null,
          startCount: gate.startCount, walkedCount: gate.walkedCount,
        }, now);
        deps.log(`Scheduled tagging starting (${gate.detail})`);
        activeRun = true;
        try {
          deps.start(gate.run, auto, onExit);
        } catch (err: any) {
          activeRun = false;
          const msg = err?.message || String(err);
          deps.log(`Scheduled tagging failed: could not start (${msg}). Not retried; the next run is tomorrow`);
          await saved;
          await save({ outcome: 'failed', detail: `could not start: ${msg}` }, now);
          return;
        }
        await saved;
      }
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
