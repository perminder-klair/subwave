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
// held track while one runs is skipped, and the render vetoes itself while the
// worker is separating (stem-blend.ts) rather than hold the sender behind it.
// The decisions are pick-stems-policy.ts; this module gathers the facts in
// that order and does the IO, through the analysis pass's own pieces: the
// capped download, the stems facet and its write, the stems marker, the
// budget's headroom, and the usage snapshot.

import { rm, stat } from 'node:fs/promises';
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

// Whether a pick-time separation holds the analyzer worker right now.
export function separationInFlight(): boolean {
  return separating;
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

  // A rewrite of an existing dir spends no budget, as in the pass; a net-new
  // dir needs a slot. headroomTracks reads the usage snapshot, walking only
  // when that can't be trusted.
  const dir = stemCache.dirFor(id);
  const hasExistingDir = await stat(dir).then(st => st.isDirectory(), () => false);
  const slotsLeft = hasExistingDir ? 0 : await stemCache.headroomTracks();
  if (!stemCache.stemWriteDecision({ cacheOn: true, slotsLeft, hasExistingDir }).want) return veto('budget-full');

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
        { facets: ['stems'], stems_dir: dir, complete: staged.complete },
        staged.path,
      );
    } catch (err) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      opts.log('warn', `pick-time stems: "${title}" failed after ${secs}s: ${(err as Error).message}`);
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
