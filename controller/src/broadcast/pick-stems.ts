// Pick-time stems (#2197, `transitions.pickTimeStems`, opt-in). Only the
// analysis pass used to fill the stem cache, so on a library larger than the
// budget (every real one) the seams that could blend were the ones the
// backfill happened to reach. This separates a picked track's missing windows
// while the drain holds it behind the track about to air, so the cache fills
// with what the station plays.
//
// What it can and cannot serve. Under pair drain the seam INTO a track renders
// the moment that track is picked (drain-policy.ts returns send-pair as soon as
// a successor exists), once, so a separation started at the pick never lands
// in time for it. This starts only after that pair is sent, which is also what
// keeps the single-flight worker free for the render first. What it buys is
// the track's TAIL, which has the whole of the track ahead of it to land
// before the seam out of it renders, and its HEAD, cached for the next time it
// is picked.
//
// Fire-and-forget and single-flight: the drain never awaits this, a second
// held track while one runs is skipped, and on a single-worker analyzer the
// render stands down while the worker is separating (stem-blend.ts) rather
// than hold the sender behind it. The decisions are pick-stems-policy.ts; this
// module gathers the facts in that order and does the IO, through the
// analysis pass's own pieces: the capped download, the stems facet and its
// write, the stems marker and the usage snapshot. The budget rule is its own
// (budgetVeto): a pick-time write may take a full cache a bounded way over,
// for the hourly sweep to evict back down.

import { readFile, rm } from 'node:fs/promises';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as analyzer from '../music/analyzer.js';
import * as db from '../music/library-db.js';
import * as stemCache from '../music/stem-cache.js';
import { bulkPassRunning } from '../music/tagger-lock.js';
import { quietOnlyEnabled } from '../music/analyze-quiet-pure.js';
import * as policy from './pick-stems-policy.js';

// The track this module is working on, from the first gate to the last write.
let claimed: string | null = null;
// Set only while the worker request is out: a capability probe, a cache walk
// or the download hold no worker, so the render need not stand down for them.
let separating = false;
// The station-level notice already in the booth log (policy.noticeStep).
let lastNotice: policy.PickStemsNotice | null = null;
// Tests shorten the request deadline to reach its timeout.
let deadlineOverrideMs: number | null = null;

export function _setRequestDeadlineForTests(ms: number | null): void {
  deadlineOverrideMs = ms;
}

function requestDeadlineMs(): number {
  return deadlineOverrideMs ?? policy.requestDeadlineMs(config.analyzer.requestTimeoutMs);
}

// Whether a pick-time separation holds the analyzer worker right now.
export function separationInFlight(): boolean {
  return separating;
}

function enabled(): boolean {
  return settings.get()?.transitions?.pickTimeStems === true;
}

// The tracks whose stem dirs a sweep evicts last (policy.sweepKeepLast), for
// the hourly sweep (scheduler.ts), from the live queue.
export function sweepKeepLast(queuedTrackIds: Iterable<unknown>): ReadonlySet<string> | undefined {
  return policy.sweepKeepLast({ enabled: enabled(), queuedTrackIds });
}

// The same, for the analysis pass's own end-of-pass sweep (analyze.ts). The
// pass runs in the tagger's child process, which has no live queue, so this
// reads the queue's snapshot on disk. Off, it reads nothing; an unreadable
// snapshot gives no set, which is develop's order.
export async function sweepKeepLastFromDisk(): Promise<ReadonlySet<string> | undefined> {
  if (!enabled()) return undefined;
  let snapshot: unknown = null;
  try {
    snapshot = JSON.parse(await readFile(config.queue.file, 'utf8'));
  } catch {
    return undefined;
  }
  return policy.sweepKeepLast({ enabled: true, queuedTrackIds: policy.queuedTrackIdsFromSnapshot(snapshot) });
}

export interface PickStemsOpts {
  // queue.pairDrainActive() at the call site.
  pairDrainActive: boolean;
  // The track is the queue's new held tail (see PickStemsStation.held).
  held: boolean;
  log: (kind: string, message: string) => void;
}

export type PickStemsOutcome =
  | { ran: false; veto: policy.PickStemsVeto }
  // Turned away by a failure before the worker was asked (the download).
  | { ran: false; error: string }
  | { ran: true; ok: boolean; ms: number };

function stationFacts(opts: PickStemsOpts): policy.PickStemsStation {
  const s = settings.get();
  return {
    enabled: s?.transitions?.pickTimeStems === true,
    stemBlends: s?.transitions?.stemBlends === true,
    stemCache: s?.audio?.stemCache === true,
    pairDrainActive: opts.pairDrainActive,
    held: opts.held,
    quietOnly: quietOnlyEnabled(process.env.ANALYZE_QUIET_ONLY, s?.audio),
  };
}

// Settings first, then the pidfile read: a station with this off reads nothing.
function gate(opts: PickStemsOpts, inFlight: boolean): policy.PickStemsVeto | null {
  return policy.stationVeto(stationFacts(opts))
    ?? policy.busyVeto({ bulkPassRunning: bulkPassRunning(), inFlight });
}

// Never rejects: the drain calls this with `void`.
export async function maybeSeparateAtPick(
  track: { id?: string | null; title?: string | null },
  opts: PickStemsOpts,
): Promise<PickStemsOutcome> {
  const outcome = await attempt(track, opts);
  const step: policy.PickStemsStep = outcome.ran
    ? { ran: true }
    : {
      ran: false,
      veto: 'veto' in outcome ? outcome.veto : null,
      // Read only for a quiet-only veto: the setting has its own note on the
      // Stems page, the env var has none.
      quietOnlyFromEnv: 'veto' in outcome && outcome.veto === 'quiet-only'
        && quietOnlyEnabled(process.env.ANALYZE_QUIET_ONLY, null),
    };
  try {
    const { say, last } = policy.noticeStep(lastNotice, step);
    lastNotice = last;
    if (say) opts.log('warn', policy.NOTICE_MESSAGES[say]);
  } catch { /* a notice is never worth a rejection */ }
  return outcome;
}

async function attempt(
  track: { id?: string | null; title?: string | null },
  opts: PickStemsOpts,
): Promise<PickStemsOutcome> {
  const id = track?.id ? String(track.id) : '';
  const title = track?.title || id;
  try {
    const first = gate(opts, claimed !== null);
    if (first) return { ran: false, veto: first };
    if (!id) return { ran: false, veto: 'no-grid' };
    // Claimed before the first await, so a second call can't pass the gate too.
    claimed = id;
    try {
      return await separate(id, title, opts);
    } finally {
      claimed = null;
    }
  } catch (err) {
    // Optional work: whatever broke, the drain and the seam are untouched.
    const message = (err as Error)?.message || String(err);
    opts.log('warn', `pick-time stems: "${title}" skipped: ${message}`);
    return { ran: false, error: message };
  }
}

async function separate(id: string, title: string, opts: PickStemsOpts): Promise<PickStemsOutcome> {
  const veto = (v: policy.PickStemsVeto): PickStemsOutcome => ({ ran: false, veto: v });

  // facetsAvailable() resolves the backend first, so the Demucs flag below is
  // the probed one rather than the unprobed null.
  const facets = await analyzer.facetsAvailable();
  const capability = policy.analyzerVeto({ facets, demucs: analyzer.vocalActivityAvailable() });
  if (capability) return veto(capability);

  const row = db.isOpen() ? db.getTrack(id) : null;
  if (!row) return veto('no-grid');
  const [hasHead, hasTail] = await Promise.all([
    stemCache.hasWindow(id, 'head'),
    stemCache.hasWindow(id, 'tail'),
  ]);
  const need = policy.trackNeed({
    hasHeadGrid: !!row.bars?.length,
    hasTailGrid: !!row.outro?.bars?.length && !!row.durationSec,
    hasHead,
    hasTail,
  });
  if (typeof need === 'string') return veto(need);

  // Never write to an unmounted share as if it were the cache. `prepare`, as
  // the pass does before its first write: a new empty cache gets its marker.
  const root = await stemCache.stemsRootStatus({ prepare: true });
  if (!root.online) return veto('root-offline');

  // A pick-time write may take the cache over its budget, by a bounded
  // allowance (budgetVeto). usage() reads the snapshot, walking only when
  // that can't be trusted.
  const dir = stemCache.dirFor(id);
  const used = await stemCache.usage();
  const overBudget = policy.budgetVeto({
    usedBytes: used.bytes,
    budgetBytes: stemCache.budgetBytes(),
    estTrackBytes: used.estTrackBytes,
  });
  if (overBudget) return veto(overBudget);

  let staged: { path: string; complete: boolean };
  try {
    staged = await analyzer.downloadCapped(id);
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    opts.log('warn', `pick-time stems: "${title}" skipped, download failed: ${message}`);
    return { ran: false, error: message };
  }
  try {
    const late = policy.afterDownload(need, staged.complete);
    if (late) return veto(late);
    // The station may have moved on while the probes and the download ran: an
    // operator switched it off, or a bulk pass took the worker.
    const again = gate(opts, false);
    if (again) return veto(again);

    const before = await stemCache.trackDirBytes(id);
    const what = policy.describeNeed(need);
    const t0 = Date.now();
    opts.log('mix', `pick-time stems: separating "${title}" (${what}) while it waits`);
    let res: analyzer.FacetAnalysis;
    separating = true;
    try {
      res = await analyzer.analyzeFacets(
        id,
        {
          facets: ['stems'],
          stems_dir: dir,
          stems_windows: policy.stemsWindowsFor(need),
          complete: staged.complete,
          timeoutMs: requestDeadlineMs(),
        },
        staged.path,
      );
    } catch (err) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      opts.log('warn', analyzer.isTimeoutError(err)
        ? `pick-time stems: "${title}" timed out after ${secs}s (the worker may still finish)`
        : `pick-time stems: "${title}" failed after ${secs}s: ${(err as Error).message}`);
      // A request that timed out may still be separating on the worker, so
      // the dir can grow after any measure taken now: let the next read walk.
      await stemCache.markUsageStale();
      return { ran: true, ok: false, ms: Date.now() - t0 };
    } finally {
      separating = false;
    }
    const ms = Date.now() - t0;
    const secs = (ms / 1000).toFixed(1);
    // Whatever the answer, the worker may have written part of a set.
    await stemCache.settleTrackWrite(id, before);
    const answer = res.facets.stems;
    if (answer?.status !== 'ok') {
      opts.log('warn', `pick-time stems: "${title}" failed after ${secs}s: ${answer?.reason || answer?.status || 'no stems answer'}`);
      return { ran: true, ok: false, ms };
    }
    // The stamp records the attempt, as the pass's does (stems_at), so the
    // backfill doesn't separate this track again.
    db.writeFacetResults(id, {
      source: res.source.kind === 'capped-download'
        ? (res.source.complete === false ? 'capped' : 'url')
        : staged.complete ? 'full' : 'capped',
      stems: { attempted: true },
    });
    const [head, tail] = await Promise.all([
      stemCache.hasWindow(id, 'head'),
      stemCache.hasWindow(id, 'tail'),
    ]);
    const cached = [head && 'head', tail && 'tail'].filter(Boolean).join(' + ') || 'nothing';
    opts.log('mix', `pick-time stems: "${title}" done in ${secs}s (${cached} cached)`);
    return { ran: true, ok: true, ms };
  } finally {
    await rm(staged.path, { force: true }).catch(() => {});
  }
}
