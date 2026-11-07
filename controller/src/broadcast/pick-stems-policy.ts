// Whether a picked track gets its missing stem windows separated while the
// drain holds it (#2197). Pure: broadcast/pick-stems.ts gathers the facts in
// stages, cheapest first, and asks each stage here, so nothing expensive (a
// backend probe, a cache walk, a download) runs for a track an earlier stage
// already turned away. Pinned by scripts/pick-stems-policy.test.ts.
//
// Every veto is a reason string, for the test and for a caller that wants to
// say why. The runner logs the separations it starts, plus one line when a
// station-level reason the Stems page can't show first stops them (noticeStep).

import { seamSides } from '../music/stem-priority.js';

export type PickStemsVeto =
  // Station
  | 'off'            // transitions.pickTimeStems
  | 'no-blends'      // transitions.stemBlends: stems with no consumer
  | 'no-cache'       // audio.stemCache: the cache is the operator's opt-in to the disk
  | 'no-pair-drain'  // no pair drain or no DJ-mode persona: blends never render
  | 'not-held'       // the track is about to be sent, so its tail can't land first
  | 'quiet-only'     // quiet-only analysis: no Demucs while anyone may be listening
  | 'bulk-pass'      // a bulk pass holds the worker
  | 'in-flight'      // one pick-time separation at a time
  // Analyzer
  | 'no-facets'      // the backend predates the facet protocol (or is unknown)
  | 'no-demucs'      // the light image, or Demucs failed to load
  // Track
  | 'no-grid'        // no bar grid on either side: a blend would reject its stems
  | 'cached'         // every window its grids can use is already on disk
  | 'root-offline'   // the stems share is not mounted (stem-cache.ts marker)
  | 'budget-full'    // the cache is past its budget plus the pick-time allowance (budgetVeto)
  | 'truncated';     // only the tail is missing and the capped download has no tail

export interface PickStemsStation {
  enabled: boolean;
  stemBlends: boolean;
  stemCache: boolean;
  // queue.pairDrainActive(): pair drain on, DJ-mode persona.
  pairDrainActive: boolean;
  // The track is the queue's last item, behind a pair that was just sent, so
  // the drain holds it until its own successor is picked.
  held: boolean;
  quietOnly: boolean;
}

// Settings and the queue's shape: no IO behind any of it, so a station with
// the feature off pays nothing past the first field. Quiet-only switches this
// off outright (maintainer decision on #2197): an operator who asked for
// Demucs only while nobody listens, often for a small GPU's sake, has said no
// to a separation per track during the broadcast.
export function stationVeto(s: PickStemsStation): PickStemsVeto | null {
  if (!s.enabled) return 'off';
  if (!s.stemBlends) return 'no-blends';
  if (!s.stemCache) return 'no-cache';
  if (!s.pairDrainActive) return 'no-pair-drain';
  if (!s.held) return 'not-held';
  if (s.quietOnly) return 'quiet-only';
  return null;
}

// Whether the worker is spoken for: a bulk pass (its pidfile) or another
// pick-time separation.
export function busyVeto(b: { bulkPassRunning: boolean; inFlight: boolean }): PickStemsVeto | null {
  if (b.bulkPassRunning) return 'bulk-pass';
  if (b.inFlight) return 'in-flight';
  return null;
}

// Only `=== true` counts: null is a backend that never reported the capability.
export function analyzerVeto(a: { facets: boolean | null; demucs: boolean | null }): PickStemsVeto | null {
  if (a.facets !== true) return 'no-facets';
  if (a.demucs !== true) return 'no-demucs';
  return null;
}

export interface PickStemsTrackFacts {
  // The grids maybeRenderBlend demands for each side (stem-priority.ts facts):
  // bars for the incoming head, outro bars plus a duration for the outgoing tail.
  hasHeadGrid: boolean;
  hasTailGrid: boolean;
  // What the cache already holds (stemCache.hasWindow).
  hasHead: boolean;
  hasTail: boolean;
}

export interface PickStemsNeed {
  head: boolean;
  tail: boolean;
}

// Which windows are worth separating. A window without its grid is bytes the
// render is guaranteed to reject, and a track with no grid at all has not been
// analysed: this never measures a track at pick time, it only separates.
export function trackNeed(t: PickStemsTrackFacts): PickStemsNeed | PickStemsVeto {
  if (seamSides(t) === 0) return 'no-grid';
  const need = { head: t.hasHeadGrid && !t.hasHead, tail: t.hasTailGrid && !t.hasTail };
  return need.head || need.tail ? need : 'cached';
}

// After the capped download. The worker separates no tail from a truncated
// file (no outro to align to), and it always separates the head, so when the
// tail is all that is missing a truncated file would spend a head separation
// rewriting stems already on disk.
export function afterDownload(need: PickStemsNeed, complete: boolean): PickStemsVeto | null {
  if (need.head) return null;
  return need.tail && complete ? null : 'truncated';
}

export function describeNeed(need: PickStemsNeed): string {
  return need.head && need.tail ? 'head + tail' : need.head ? 'head' : 'tail';
}

// ---- the budget -----------------------------------------------------------
// A pick-time write may take the cache over its byte budget. The analysis
// pass sizes its stems to the budget's headroom, and once the backfill has
// filled the cache (the steady state on any real library, music.md) that
// headroom is 0 for good. Held to the pass's rule, pick-time stems would then
// add nothing new, and nothing would ever make room either, because the sweep
// evicts only a cache that is over budget. So a pick-time write may run over,
// and the hourly sweep (scheduler.ts, at :02) evicts back down in stem-priority
// order (stem-priority.ts): lowest priority first, then oldest. That order
// alone would put a just-separated track first: until it airs it scores as
// never-aired (200 with both grids, 100 with one), below a two-sided dir aired
// in the last 90 days (320 and up), and once pick-time stems has run for a
// while nearly every dir left in the cache has aired. So while this is on, both sweeps
// evict the dirs of tracks still in the queue last (sweepKeepLast below); once
// a track airs it leaves the queue and ranks on its airplay. The pass's own
// rule is untouched: over budget, its headroom stays 0 and it adds nothing.
//
// The overshoot is bounded. Writes stop once the cache is OVERSHOOT_DIRS dirs
// (at its own measured average) over budget, and start again when the sweep
// has made room. That is about an hour of picks, which is the sweep's
// interval: a held pick comes about once a track, 15-20 an hour at 3-4
// minutes, so an ordinary hour is never turned away and the next sweep
// reclaims the lot in one run. On the default 15 GB budget, at the 10-17 MB a
// dir measured on the real worker, that is 200-340 MB, about 2%.
// OVERSHOOT_FRACTION caps it for a small budget, set for a small disk, which
// 20 dirs could push 50% over. It is never less than one dir, so even the
// smallest budget turns over one pick per sweep.
export const OVERSHOOT_DIRS = 20;
export const OVERSHOOT_FRACTION = 0.05;

export function overshootAllowanceBytes(budgetBytes: number, estTrackBytes: number): number {
  return Math.max(estTrackBytes, Math.min(OVERSHOOT_DIRS * estTrackBytes, OVERSHOOT_FRACTION * budgetBytes));
}

// How far over its budget pick-time stems may take the cache by design: the
// allowance, plus the one separation admitted just under it. The Stems page
// reads it (GET /stem-cache/usage) so that overshoot is not shown as a fault.
export function designedOvershootBytes(budgetBytes: number, estTrackBytes: number): number {
  return overshootAllowanceBytes(budgetBytes, estTrackBytes) + estTrackBytes;
}

// One rule for a net-new dir and for a tail added to a dir already there:
// admitted while the cache is under budget + allowance. A separation writes one
// dir and the runner settles it before the next one may start, so the cache
// stops at budget + allowance + one dir, however many picks come before the
// sweep. A request that timed out releases the claim while its worker may
// still be writing, unmeasured, and the next pick may start another: with one
// worker it queues behind the first and, if it too times out while queued,
// finds its staging file gone and writes nothing, so the worst case is one dir
// more; with a sidecar pool each member can hold one such orphan, so it is up
// to ANALYZE_CONCURRENCY (at most 8) dirs more.
//
// The rule judges the bytes the sweep can evict. Folders this user cannot
// delete (stem-cache.ts sweep, a share's permissions) leave the sweep's own
// budget check, so it stops evicting once the rest fits. Counted here, they
// kept the cache "full" for good once they exceeded the allowance: one pick was
// admitted, every later one was turned away, and the notice's "until the hourly
// sweep makes room" never came true, because the sweep had nothing left to do
// (#2253). `unevictableBytes` is what the last over-budget sweep found (0 when
// unknown, as after a walk, which is the old rule). So with stuck folders the
// cache can sit over budget by their size plus the allowance, and the sweep
// still takes the evictable part back down to the budget.
export function budgetVeto(u: {
  usedBytes: number;
  budgetBytes: number;
  estTrackBytes: number;
  unevictableBytes?: number;
}): PickStemsVeto | null {
  const ceiling = u.budgetBytes + overshootAllowanceBytes(u.budgetBytes, u.estTrackBytes);
  const stuck = Number.isFinite(u.unevictableBytes) && (u.unevictableBytes as number) > 0 ? (u.unevictableBytes as number) : 0;
  const evictable = Math.max(0, u.usedBytes - stuck);
  return evictable < ceiling ? null : 'budget-full';
}

// ---- the sweep ------------------------------------------------------------
// The tracks whose stem dirs both sweeps (the hourly one and the analysis
// pass's own) evict last: those still in the queue, not yet aired. Only while
// pick-time stems is on; off, or with nothing queued, there is no set and both
// sweeps keep develop's order exactly. Kept last, never kept: a sweep still
// evicts them once nothing else is left over budget, so the bound above holds.
export function sweepKeepLast(s: { enabled: boolean; queuedTrackIds: Iterable<unknown> }): ReadonlySet<string> | undefined {
  if (!s.enabled) return undefined;
  const ids = new Set<string>();
  for (const id of s.queuedTrackIds) {
    if (typeof id === 'string' && id) ids.add(id);
  }
  return ids.size ? ids : undefined;
}

// The queued track ids in the queue's own snapshot (queue.json, written by
// Queue.persist). The analysis pass runs in a child process with no live
// queue, so its sweep reads them here. Anything unexpected reads as none,
// which leaves that sweep in plain stem-priority order.
export function queuedTrackIdsFromSnapshot(snapshot: unknown): string[] {
  const upcoming = (snapshot as { upcoming?: unknown } | null)?.upcoming;
  if (!Array.isArray(upcoming)) return [];
  const ids: string[] = [];
  for (const item of upcoming) {
    const id = (item as { track?: { id?: unknown } } | null)?.track?.id;
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

// ---- the request ----------------------------------------------------------
// The facet request's own deadline. Nothing waits on it: it bounds how long
// `separating` (and so the render's stand-down), the claim and the staging
// file outlive a worker that never answers. Under the pass's deadline
// (ANALYZE_REQUEST_TIMEOUT_MS, 120 s) a slow CPU gave up on separations the
// worker went on to finish: head + tail measured 82 s on 4 CPUs and 165-176 s
// on 2 (htdemucs, cold and warm). The client then logged a failure, lifted
// the stand-down with the worker still busy, wrote no stems_at stamp (so the
// next pass separated the track again) and skipped the budget settle. 300 s is
// 1.7x the slowest measurement, and never shorter than an operator's own
// ANALYZE_REQUEST_TIMEOUT_MS.
export const REQUEST_DEADLINE_MS = 300_000;

export function requestDeadlineMs(passTimeoutMs: number): number {
  return Math.max(REQUEST_DEADLINE_MS, passTimeoutMs);
}

// ---- the render -----------------------------------------------------------
// Whether maybeRenderBlend stands down for a separation in flight. It asks
// only for a cache hit (a miss returns before any worker call), so this costs
// exactly the seams that would have blended. With one worker that is still
// the better trade: measured, a cache-hit render that arrived 3 s into a
// separation waited 78 s, past the render's own 60 s budget, so it would lose
// the blend anyway and hold the sender for the whole budget first. A sidecar
// pool with a spare member serves the render at once.
//
// The controller knows the pool only from its own ANALYZE_CONCURRENCY: the
// sidecar's /health does not report it. The compose files hand both services
// the same root .env value, and a remote analyzer is told to match it
// (docs/tts-heavy.md). A controller set higher than its sidecar costs one
// render that waits out its budget and falls back to the plain crossfade,
// bounded by the drain's hard deadline. A local ANALYZE_PYTHON worker is
// single-flight whatever the setting.
export function renderStandsDown(r: { separating: boolean; backend: string; concurrency: number }): boolean {
  if (!r.separating) return false;
  return !(r.backend === 'sidecar' && r.concurrency >= 2);
}

// ---- notices --------------------------------------------------------------
// Station-level reasons nothing is separated that the Stems page cannot show:
// the budget, an analyzer without Demucs or the facet protocol, and quiet-only
// analysis forced on by ANALYZE_QUIET_ONLY (the page's note reads only the
// saved setting). One booth-log line when one first applies or changes, never
// one per pick. A separation that reaches the worker, or the feature switched
// off, clears it, so the next onset is reported again.
export type PickStemsNotice = 'budget-full' | 'no-demucs' | 'no-facets' | 'quiet-only-env';

export const NOTICE_MESSAGES: Record<PickStemsNotice, string> = {
  'budget-full': 'pick-time stems: the stem cache is past its budget plus the pick-time allowance, '
    + 'so no new track is separated until the hourly sweep makes room',
  'no-demucs': 'pick-time stems: on, but the analyzer has no Demucs (a light image, or the model failed to load), '
    + 'so nothing is separated',
  // facetsAvailable() is null both for an image that predates the facet
  // protocol and for no analyzer answering at all, so name both.
  'no-facets': 'pick-time stems: on, but the analyzer is not answering or predates per-facet requests, '
    + 'so nothing is separated; check that it is running and up to date',
  'quiet-only-env': 'pick-time stems: on, but ANALYZE_QUIET_ONLY is set, and quiet-only analysis switches '
    + 'pick-time separation off',
};

export type PickStemsStep =
  | { ran: true }
  | { ran: false; veto: PickStemsVeto | null; quietOnlyFromEnv?: boolean };

function noticeOf(step: Extract<PickStemsStep, { ran: false }>): PickStemsNotice | null {
  switch (step.veto) {
    case 'budget-full': return 'budget-full';
    case 'no-demucs': return 'no-demucs';
    case 'no-facets': return 'no-facets';
    case 'quiet-only': return step.quietOnlyFromEnv ? 'quiet-only-env' : null;
    default: return null;
  }
}

// `last` is the notice already said; `say` is the one to log now, if any.
// Track-level outcomes (cached, in flight, a failed download) leave it be.
export function noticeStep(
  last: PickStemsNotice | null,
  step: PickStemsStep,
): { say: PickStemsNotice | null; last: PickStemsNotice | null } {
  if (step.ran || step.veto === 'off') return { say: null, last: null };
  const notice = noticeOf(step);
  if (!notice) return { say: null, last };
  return { say: notice === last ? null : notice, last: notice };
}
