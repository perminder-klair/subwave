// Hour markers: a time a queued track must keep, like the markers in a
// broadcast playlist ("news at 07:00"). The design is docs/plans/hour-markers.md.
//
// PROPOSED, NOT WIRED. No route, drain or watcher calls this yet. It exists so
// the rules can be reviewed as code and pinned by tests before anything on the
// air path changes.
//
// A marker belongs to the queue item that must follow it, its ANCHOR. Two kinds:
//   - soft: late? Let the track airing at the marker time finish, drop the
//     unsent rows that would only START after it, and carry on from the anchor.
//   - hard: the same drops, and the track airing at the marker time ENDS at
//     it, so the anchor starts on the dot (news, network joins).
// A third kind, `wait` (early? hold until the time), is an open question in the
// plan: the station must keep making sound, so something has to fill the hold.
//
// The plan runs over forecastQueue, the clock behind GET /state's `airsAt`, so
// what an operator app shows and what the station does cannot disagree.
// Unknown is never acted on: a marker whose forecast is unknown is reported and
// left alone, never used to drop music on a guess. A sent row is never dropped
// (it is already in the mixer), and its end is already fixed, so only a timed
// skip could still cut it.
//
// Pure: no I/O and no clock reads; the caller passes `nowMs`.

import { forecastQueue, type ForecastRow } from './drain-policy.js';
import { BOUNDARY_MIN_PLAY_SEC } from './show-boundary.js';

export type MarkerKind = 'soft' | 'hard';

export interface QueueMarker {
  id: string;
  /** Epoch ms the anchor must start by (soft) or exactly at (hard). */
  at: number;
  kind: MarkerKind;
}

export interface MarkerRow extends ForecastRow {
  /** Set on the row the marker comes before: its anchor. */
  marker?: QueueMarker | null;
}

/** A hard marker leaves a track alone when it ends this close to the marker
 *  anyway: a cut that short is a click, not a join. */
export const MARKER_HARD_TOLERANCE_SEC = 5;

/** The shortest a track may play before a hard marker cuts it: the
 *  show-boundary fade's floor, for the same reason (a stub is worse). Below
 *  it, an unsent track is dropped, so the anchor starts that much early. */
export const MARKER_MIN_PLAY_SEC = BOUNDARY_MIN_PLAY_SEC;

export type MarkerOutcome =
  /** The anchor keeps the marker, after this plan's drops and cuts. */
  | { kind: 'on-time' }
  /** The on-air clock or a length ahead is unknown: nothing was decided. */
  | { kind: 'unknown' }
  /** Rows already sent push the anchor past the marker by `bySec`. */
  | { kind: 'late'; bySec: number }
  /** A hard anchor starts `bySec` before the marker; only a wait marker could hold it. */
  | { kind: 'early'; bySec: number };

export interface MarkerPlan {
  /** Row indexes to take out of the queue, ascending. Never a sent row. */
  drop: number[];
  /** Unsent rows that must end by a time, folded into cue_out at their drain
   *  exactly as the show-boundary fade is (resolveBoundaryCueSec). */
  endBy: { index: number; atMs: number; markerId: string }[];
  /** A sent row, or the on-air track, still runs past a hard marker. Its cue
   *  is fixed, so only a skip at `atMs` honours it (a cut, not a fade). */
  skipAt: { target: number | 'on-air'; atMs: number; markerId: string }[];
  /** One entry per marker, in queue order. */
  markers: { markerId: string; anchor: number; outcome: MarkerOutcome }[];
}

/** What to do about every marker in the queue, in queue order. Each marker sees
 *  the queue as the markers before it left it (their drops and cuts). */
export function planMarkers(input: {
  nowMs: number;
  /** Seconds left of the on-air track, or null when unknown. */
  onAirRemainingSec: number | null;
  rows: MarkerRow[];
}): MarkerPlan {
  const { nowMs, rows } = input;
  const plan: MarkerPlan = { drop: [], endBy: [], skipAt: [], markers: [] };
  const dropped = new Set<number>();
  // Cuts already planned shorten what airs, so later markers must see them.
  const playable = new Map<number, number>();
  let onAirRemaining = input.onAirRemainingSec;

  const playableOf = (i: number) => playable.get(i) ?? rows[i].playableSec;
  // Start (epoch ms) of every kept row, or null where the forecast is unknown.
  const starts = (): Map<number, number | null> => {
    const kept = rows.map((_, i) => i).filter((i) => !dropped.has(i));
    const airs = forecastQueue(onAirRemaining, kept.map((i) => ({ ...rows[i], playableSec: playableOf(i) })));
    return new Map(kept.map((i, n) => [i, airs[n] == null ? null : nowMs + airs[n]! * 1000]));
  };
  const endOf = (at: Map<number, number | null>, i: number | 'on-air'): number | null => {
    if (i === 'on-air') return onAirRemaining == null ? null : nowMs + onAirRemaining * 1000;
    const start = at.get(i);
    const sec = playableOf(i);
    return start == null || sec == null ? null : start + sec * 1000;
  };

  rows.forEach((row, anchor) => {
    const marker = row.marker;
    if (!marker || dropped.has(anchor)) return;
    const report = (outcome: MarkerOutcome): void => {
      plan.markers.push({ markerId: marker.id, anchor, outcome });
    };

    let at = starts();
    if (at.get(anchor) == null) return report({ kind: 'unknown' });

    // 1. Unsent rows ahead that would only start at or after the marker go.
    //    Starts only grow along the queue, so these are a tail of the rows ahead.
    for (const [i, start] of at) {
      if (i >= anchor || start == null || start < marker.at || rows[i].sent) continue;
      dropped.add(i);
      plan.drop.push(i);
    }
    at = starts();
    const ahead = [...at.keys()].filter((i) => i < anchor);
    const anchorStart = at.get(anchor)!;
    // The row airing at the marker: the last one ahead that starts before it.
    const beforeMarker = ahead.filter((i) => at.get(i)! < marker.at);
    const atMarker: number | 'on-air' = beforeMarker.length ? beforeMarker[beforeMarker.length - 1] : 'on-air';
    const sentAfter = ahead.some((i) => at.get(i)! >= marker.at);

    // 2. Sent rows that start after the marker cannot be dropped: report how
    //    far they push the anchor beyond the earliest it could have started.
    if (sentAfter) {
      const earliest = endOf(at, atMarker) ?? anchorStart;
      return report({ kind: 'late', bySec: Math.max(0, (anchorStart - earliest) / 1000) });
    }
    if (marker.kind === 'soft') return report({ kind: 'on-time' });

    // 3. Hard: the row airing at the marker must end at it.
    const end = endOf(at, atMarker)!;
    const tolerance = MARKER_HARD_TOLERANCE_SEC * 1000;
    if (end < marker.at - tolerance) return report({ kind: 'early', bySec: (marker.at - anchorStart) / 1000 });
    if (end <= marker.at + tolerance) return report({ kind: 'on-time' });

    if (atMarker === 'on-air' || rows[atMarker].sent) {
      plan.skipAt.push({ target: atMarker, atMs: marker.at, markerId: marker.id });
      if (atMarker === 'on-air') onAirRemaining = Math.max(0, (marker.at - nowMs) / 1000);
      else playable.set(atMarker, (marker.at - at.get(atMarker)!) / 1000);
      return report({ kind: 'on-time' });
    }
    const playedSec = (marker.at - at.get(atMarker)!) / 1000;
    if (playedSec >= MARKER_MIN_PLAY_SEC) {
      plan.endBy.push({ index: atMarker, atMs: marker.at, markerId: marker.id });
      playable.set(atMarker, playedSec);
      return report({ kind: 'on-time' });
    }
    // Cutting would leave a stub: drop it, and the anchor starts that much early.
    dropped.add(atMarker);
    plan.drop.push(atMarker);
    report({ kind: 'early', bySec: (marker.at - starts().get(anchor)!) / 1000 });
  });

  plan.drop.sort((a, b) => a - b);
  return plan;
}
