// Whether a picked track gets its missing stem windows separated while the
// drain holds it (#2197). Pure: broadcast/pick-stems.ts gathers the facts in
// stages, cheapest first, and asks each stage here, so nothing expensive (a
// backend probe, a cache walk, a download) runs for a track an earlier stage
// already turned away. Pinned by scripts/pick-stems-policy.test.ts.
//
// Every veto is a reason string, for the test and for a caller that wants to
// say why; the runner logs only separations it starts.

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
  | 'budget-full'    // a net-new dir with no headroom left (stemWriteDecision)
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
