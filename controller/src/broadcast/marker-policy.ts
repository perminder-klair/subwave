// Hour markers: a time a queued track must keep, like the markers in a
// broadcast playlist ("news at 07:00"). The design is docs/plans/hour-markers.md.
//
// A marker belongs to the queue item that must follow it, its ANCHOR. Two kinds:
//   - soft: late? Let the track airing at the marker time finish, drop the
//     unsent rows that would only START after it, and carry on from the anchor.
//   - hard: the same drops, and the track airing at the marker time ENDS at
//     it, so the anchor starts on the dot (news, network joins).
// Both WAIT when early: an anchor that would start a whole track's floor
// before its time is held back from the mixer, and with nothing queued ahead
// of it the station plays the auto playlist until it can join on time.
//
// The plan runs over forecastQueue, the clock behind GET /state's `airsAt`, so
// what an operator app shows and what the station does cannot disagree.
// Unknown is never acted on: a marker whose forecast is unknown drops nothing.
// A sent row is never dropped (it is already in the mixer), and neither is
// another anchor, which is an operator instruction of its own.
//
// Pure: no I/O and no clock reads; the caller passes `nowMs`.

import { forecastQueue, HARD_DEADLINE_SEC, type ForecastRow } from './drain-policy.js';
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
 *  it, an unsent track is dropped, so the anchor starts that much early. It is
 *  also the wait's floor: an anchor this early or more is held, and anything
 *  less early joins early rather than leave the auto playlist a stub to fill. */
export const MARKER_MIN_PLAY_SEC = BOUNDARY_MIN_PLAY_SEC;

/** A held anchor goes to the mixer at least this long before its marker: the
 *  drain's own hard deadline, by which Liquidsoap must have the next track. */
export const MARKER_RELEASE_LEAD_SEC = HARD_DEADLINE_SEC;

export type MarkerOutcome =
  /** The anchor keeps the marker, after this plan's drops and cuts. */
  | { kind: 'on-time' }
  /** The on-air clock or a length ahead is unknown: nothing was decided. */
  | { kind: 'unknown' }
  /** Held back: the anchor would start `bySec` early, so the auto playlist
   *  fills until it can join on time. */
  | { kind: 'waiting'; bySec: number }
  /** Rows already sent push the anchor past the marker by `bySec`. */
  | { kind: 'late'; bySec: number }
  /** The anchor starts `bySec` before the marker: it is already sent, or
   *  under the wait's floor. */
  | { kind: 'early'; bySec: number };

export interface MarkerPlan {
  /** Row indexes to take out of the queue, ascending. Never a sent row or an anchor. */
  drop: number[];
  /** Unsent anchors the drain must not send yet, ascending. */
  hold: number[];
  /** Unsent rows that must end by a time, folded into cue_out at their drain
   *  exactly as the show-boundary fade is (resolveBoundaryCueSec). A sent or
   *  on-air track already has its cue, so markerCutDue ends it instead. */
  endBy: { index: number; atMs: number; markerId: string }[];
  /** One entry per marker, in queue order. */
  markers: { markerId: string; anchor: number; outcome: MarkerOutcome }[];
}

/** What to do about every marker in the queue, in queue order. Each marker sees
 *  the queue as the markers before it left it (their drops, cuts and waits). */
export function planMarkers(input: {
  nowMs: number;
  /** Seconds left of the on-air track, or null when unknown. */
  onAirRemainingSec: number | null;
  rows: MarkerRow[];
}): MarkerPlan {
  const { nowMs, rows } = input;
  const plan: MarkerPlan = { drop: [], hold: [], endBy: [], markers: [] };
  const dropped = new Set<number>();
  // Cuts and waits already planned change what airs, so later markers must see
  // them: a cut shortens a row, and a wait lengthens the row ahead of its anchor
  // by the auto playlist that fills the gap.
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
  // Seconds `i` (a row ahead, or the on-air track) will now play until `untilMs`.
  const runUntil = (at: Map<number, number | null>, i: number | 'on-air', untilMs: number): number =>
    i === 'on-air' ? (untilMs - nowMs) / 1000 : (untilMs - at.get(i)!) / 1000;
  const setRun = (i: number | 'on-air', sec: number): void => {
    if (i === 'on-air') onAirRemaining = Math.max(0, sec);
    else playable.set(i, Math.max(0, sec));
  };

  rows.forEach((row, anchor) => {
    const marker = row.marker;
    if (!marker) return;
    const report = (outcome: MarkerOutcome): void => {
      plan.markers.push({ markerId: marker.id, anchor, outcome });
    };

    let at = starts();
    if (at.get(anchor) == null) {
      // Nothing is dropped on a guess. An unsent anchor still waits for its
      // time, so an unknown clock cannot air it early; it goes to the mixer by
      // the release lead, and a hard marker's cut needs no forecast.
      if (!row.sent && nowMs < marker.at - MARKER_RELEASE_LEAD_SEC * 1000) plan.hold.push(anchor);
      return report({ kind: 'unknown' });
    }

    // 1. Unsent rows ahead that would only start at or after the marker go.
    //    Starts only grow along the queue, so these are a tail of the rows ahead.
    for (const [i, start] of at) {
      if (i >= anchor || start == null || start < marker.at || rows[i].sent || rows[i].marker) continue;
      dropped.add(i);
      plan.drop.push(i);
    }
    at = starts();
    const ahead = [...at.keys()].filter((i) => i < anchor);
    const anchorStart = at.get(anchor)!;
    // The row airing at the marker: the last one ahead that starts before it.
    const beforeMarker = ahead.filter((i) => at.get(i)! < marker.at);
    const atMarker: number | 'on-air' = beforeMarker.length ? beforeMarker[beforeMarker.length - 1] : 'on-air';
    const keptAfter = ahead.some((i) => at.get(i)! >= marker.at);

    // 2. Sent rows (or another anchor) that start after the marker cannot be
    //    dropped: report how far they push the anchor beyond the earliest it
    //    could have started.
    if (keptAfter) {
      const earliest = endOf(at, atMarker) ?? anchorStart;
      return report({ kind: 'late', bySec: Math.max(0, (anchorStart - earliest) / 1000) });
    }

    // 3. Early by the wait's floor or more: hold an unsent anchor. The plan
    //    runs again as the auto playlist plays, and releases it once it would
    //    join under the floor.
    const earlySec = (marker.at - anchorStart) / 1000;
    if (earlySec >= MARKER_MIN_PLAY_SEC) {
      if (row.sent) return report({ kind: 'early', bySec: earlySec });
      plan.hold.push(anchor);
      setRun(atMarker, runUntil(at, atMarker, marker.at));
      return report({ kind: 'waiting', bySec: earlySec });
    }
    if (marker.kind === 'soft') return report({ kind: 'on-time' });

    // 4. Hard: the row airing at the marker must end at it.
    const end = endOf(at, atMarker)!;
    const tolerance = MARKER_HARD_TOLERANCE_SEC * 1000;
    if (end < marker.at - tolerance) return report({ kind: 'early', bySec: earlySec });
    if (end <= marker.at + tolerance) return report({ kind: 'on-time' });

    const playedSec = runUntil(at, atMarker, marker.at);
    if (atMarker === 'on-air' || rows[atMarker].sent) {
      // Its cue is already fixed, so the cut at the marker ends it.
      setRun(atMarker, playedSec);
      return report({ kind: 'on-time' });
    }
    if (playedSec >= MARKER_MIN_PLAY_SEC || rows[atMarker].marker) {
      // An anchor is never dropped, even as a stub; its drain may decline the
      // stub cue, and then the cut at the marker ends it.
      plan.endBy.push({ index: atMarker, atMs: marker.at, markerId: marker.id });
      setRun(atMarker, playedSec);
      return report({ kind: 'on-time' });
    }
    // Cutting would leave a stub: drop it, and the anchor starts that much early.
    dropped.add(atMarker);
    plan.drop.push(atMarker);
    report({ kind: 'early', bySec: (marker.at - starts().get(anchor)!) / 1000 });
  });

  plan.drop.sort((a, b) => a - b);
  plan.hold.sort((a, b) => a - b);
  return plan;
}

/** Whether a hard anchor must go to the mixer now, however long a pair drain
 *  would otherwise hold it: the cut at the marker needs it queued behind the
 *  track it ends. */
export function markerSendDue(marker: QueueMarker | null | undefined, nowMs: number): boolean {
  return marker?.kind === 'hard' && nowMs >= marker.at - MARKER_RELEASE_LEAD_SEC * 1000;
}

/** Whether to cut the on-air track for the anchor queued next: a hard marker
 *  whose time has come, its anchor already sent, and an on-air track that will
 *  not end within the tolerance on its own. An unknown on-air clock is cut too,
 *  since the time, not a forecast, decides it. A marker that passed while the
 *  station was down is cut as soon as its anchor is queued: it catches up. */
export function markerCutDue(input: {
  nowMs: number;
  marker: QueueMarker | null | undefined;
  anchorSent: boolean;
  onAirRemainingSec: number | null;
}): boolean {
  const { marker } = input;
  if (marker?.kind !== 'hard' || !input.anchorSent || input.nowMs < marker.at) return false;
  return input.onAirRemainingSec == null || input.onAirRemainingSec > MARKER_HARD_TOLERANCE_SEC;
}
