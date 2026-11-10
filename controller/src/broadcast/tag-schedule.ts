// Scheduled tagging (#2282): the impure half. One tick, registered in
// broadcast/scheduler.ts every five minutes, gathers what
// music/tag-schedule-policy.ts `scheduleGate` asks for and acts on its answer,
// starting the run through the same startTagger/startReconcile the Run tab's
// Start reaches. Every decision (the order of the checks, the holds, the
// outcomes, the new-music baseline) is the policy module's; this file reads,
// writes and logs.
//
// What it promises, each on purpose:
//   - Off by default (settings.tagger.auto.mode). An off schedule costs a
//     settings read per tick and one read of its own record per process: no
//     Navidrome call, no listener probe.
//   - Turning it on, or moving its time, after today's time waits for the
//     next set time: settings.update() reports such a save (scheduleArmed)
//     and the record keeps its moment (`armedAt`). Only a run the station
//     owed while the controller was down is caught up the same day.
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
import { onceAsync } from '../util/async-pool.js';
import { quietAfterMinutes, quietOnlyEnabled, type QuietState } from '../music/analyze-quiet-pure.js';
import {
  EMPTY_TAG_SCHEDULE_RECORD,
  armedStep,
  holdStep,
  lapsedHold,
  normalizeTagScheduleRecord,
  restartRecovery,
  scheduleGate,
  scheduledRunEnded,
  skippedStep,
  startFailedStep,
  startingStep,
  type GateInput,
  type ScheduleStep,
  type ScheduleWaiting,
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
  let waiting: ScheduleWaiting | null = null;
  let quiet: QuietState = { quietSince: null };
  let ticking = false;

  // One read per process, shared by every first caller (a tick and a
  // GET/POST /settings arriving together in a new process), so a later read
  // can never land over a record a caller has already changed.
  // It resolves to nothing: save() replaces `record` with a new object, so
  // load() hands back the current one, never the object the read produced.
  const readOnce = onceAsync(async (): Promise<void> => {
    let raw: unknown = null;
    try { raw = await deps.readRecord(); } catch { raw = null; }
    record ??= normalizeTagScheduleRecord(raw);
  });
  async function load(): Promise<TagScheduleRecord> {
    await readOnce();
    return record ?? { ...EMPTY_TAG_SCHEDULE_RECORD };
  }

  // The in-memory record changes synchronously, before the write is awaited,
  // so a caller that does not await still orders its change before anything
  // that follows it (the start below, and the run's own end). `at` is when
  // the outcome was last set, so only a patch that sets one moves it.
  function save(patch: Partial<TagScheduleRecord>, now: Date): Promise<void> {
    const base = record ?? { ...EMPTY_TAG_SCHEDULE_RECORD };
    const at = 'outcome' in patch ? now.toISOString() : base.at;
    record = { ...base, ...patch, version: 1, at };
    return deps.writeRecord(record).catch((err: any) => {
      // The in-memory record still holds the day for this process; only a
      // restart before the next good write could repeat it.
      deps.log(`Scheduled tagging: could not save ${TAG_SCHEDULE_FILE}: ${err?.message || err}`);
    });
  }

  // Logs and saves a step exactly as the policy wrote it.
  function apply(step: ScheduleStep | null, now: Date): Promise<void> {
    if (!step) return Promise.resolve();
    if (step.message) deps.log(step.message);
    return step.patch ? save(step.patch, now) : Promise.resolve();
  }

  function clearHold() {
    waiting = null;
    quiet = { quietSince: null };
  }

  function onExit(end: TaggerRunEnd) {
    activeRun = false;
    void apply(scheduledRunEnded(record ?? EMPTY_TAG_SCHEDULE_RECORD, end), new Date());
  }

  async function tickInner(now: Date): Promise<void> {
    const rec = await load();
    await apply(restartRecovery(rec, activeRun), now);

    const auto = deps.auto();
    const { today, minuteOfDay } = deps.clock(now);

    const lapsed = lapsedHold(waiting, today, record?.lastDay ?? null);
    if (lapsed) {
      clearHold();
      await apply(lapsed, now);
    }

    const armedAt = record?.armedAt ? new Date(record.armedAt) : null;
    const input: GateInput = {
      auto,
      today,
      minuteOfDay,
      lastDay: record?.lastDay ?? null,
      walkedCount: record?.walkedCount ?? null,
      armed: armedAt ? deps.clock(armedAt) : null,
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
      case 'hold': {
        const h = holdStep(waiting, gate, today);
        if (h.message) deps.log(h.message);
        waiting = h.waiting;
        quiet = gate.quietState;
        return;
      }
      case 'skip':
        clearHold();
        await apply(skippedStep(today, gate), now);
        return;
      case 'start': {
        clearHold();
        const saved = apply(startingStep(today, now.toISOString(), gate), now);
        activeRun = true;
        try {
          deps.start(gate.run, auto, onExit);
        } catch (err: any) {
          activeRun = false;
          await saved;
          await apply(startFailedStep(err?.message || String(err)), now);
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
    /** A settings save turned the schedule on or moved its time, at `at`. */
    async armed(at: Date): Promise<void> {
      await load();
      await apply(armedStep(at), at);
    },
  };
}

/**
 * The Run tab's Start, as the schedule sends it: the saved limit (startTagger
 * reads 0 as no --limit, the Run tab's "all") and steps, vocal left to the
 * setting, and never a replaced-file answer (confirmReplaced /
 * acceptReplaced), so an unattended run holds.
 */
export function scheduledTaggerOptions(auto: TaggerAutoSettings) {
  return {
    limit: auto.limit,
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

/**
 * The untagged rows a run would ask the LLM about (WorkCounts.dbUntagged):
 * every untagged row less those whose untaggable marker (#2283) still matches
 * the input, prompt stamp and model labels a run would use. A marker gone
 * stale (another model, a vocabulary or contract bump, a metadata edit) is
 * asked again by the run, so it is work. The library DB must be open.
 */
export async function untaggedWorkCount(): Promise<number> {
  const db = await import('../music/library-db.js');
  const { rememberedUntaggable, tagModelLabels, tagPromptStamp } = await import('../music/tag-library/tag-input.js');
  const held = rememberedUntaggable(tagPromptStamp(), tagModelLabels()).size;
  return Math.max(0, db.trackCount() - db.countTagged() - held);
}

async function liveCounts(): Promise<WorkCounts & { scanning: boolean | null }> {
  const library = await import('../music/library.js');
  const db = await import('../music/library-db.js');
  const subsonic = await import('../music/subsonic.js');
  let dbRows: number | null = null;
  let dbUntagged: number | null = null;
  try {
    await library.load();
    dbRows = db.trackCount();
    dbUntagged = await untaggedWorkCount();
  } catch { /* unknown: pendingWork fails open */ }
  const { scanning, count } = await subsonic.getScanSummary();
  return { dbRows, dbUntagged, navidromeCount: count, scanning };
}

// The modules only a tick uses (the tagger, Icecast, the booth log), imported
// on the first tick. The view and settings.update()'s arm report build the
// instance without them, so a settings save never loads the queue.
interface TickRuntime {
  tagger: typeof import('./tagger.js');
  listeners: typeof import('./listeners.js');
  queue: typeof import('./queue.js');
}
let runtime: TickRuntime | null = null;

const loadRuntime = onceAsync(async (): Promise<void> => {
  runtime = {
    tagger: await import('./tagger.js'),
    listeners: await import('./listeners.js'),
    queue: await import('./queue.js'),
  };
});

function tickRuntime(): TickRuntime {
  if (!runtime) throw new Error('the tick runtime is not loaded');
  return runtime;
}

// The station's one instance, built once even when a tick and a settings
// request make the first call together: two instances would each hold their
// own record, and the stale one could write over the file or mark a live run
// interrupted.
const liveSchedule = onceAsync(async () => {
  const settings = await import('../settings.js');
  const time = await import('../time.js');
  return createTagSchedule({
    auto: () => settings.get().tagger.auto,
    clock: (now) => {
      const p = time.zonedParts(now);
      return { today: time.zonedISODate(now), minuteOfDay: p.hour * 60 + p.minute };
    },
    running: () => tickRuntime().tagger.tagger.running,
    counts: liveCounts,
    quiet: () => {
      const audio = settings.get()?.audio;
      return { enabled: quietOnlyEnabled(process.env.ANALYZE_QUIET_ONLY, audio), minutes: quietAfterMinutes(audio) };
    },
    probeListeners: () => tickRuntime().listeners.probeListenerCount(),
    start: (kind, auto, onExit) => {
      const { startTagger, startReconcile } = tickRuntime().tagger;
      // Never a replaced-file answer: an unattended run holds and says so.
      if (kind === 'reconcile') {
        startReconcile({ onExit });
        return;
      }
      startTagger({ ...scheduledTaggerOptions(auto), onExit });
    },
    readRecord: async () => JSON.parse(await readFile(RECORD_PATH, 'utf8')),
    writeRecord: (rec) => writeRecordFile(`${JSON.stringify(rec, null, 2)}\n`),
    log: (message) => {
      if (runtime) runtime.queue.queue.log('scheduler', message);
      else console.warn(`[tag-schedule] ${message}`);
    },
  });
});

export async function scheduledTagTick(): Promise<void> {
  try {
    await loadRuntime();
    await (await liveSchedule()).tick();
  } catch { /* the tick logs its own failures; wiring failures stay out of the cron */ }
}

export async function scheduledTagView(): Promise<TagScheduleView> {
  return (await liveSchedule()).view();
}

/** settings.update() saved a change that arms the schedule (scheduleArmChanged). */
export async function scheduleArmed(at: Date): Promise<void> {
  await (await liveSchedule()).armed(at);
}
