// "Is the DJ on the mic for this listener right now?" for the lock screen and
// Live Activity. The window runs from when the line became audible (live-edge
// stamp + the listener's buffer, #1114) for the clip's length: `meta.durationMs`
// when the controller sends it, else an estimate from the word count.

import { MAX_HOLD_MS, airedAtMs, isCarriedTurn } from './sessionFeed';
import type { SessionTurn } from './types';

const VOICE_TURN_KINDS = new Set([
  'voice',
  'segment',
  'link',
  'intro',
  'station-id',
  'weather',
  'hourly',
  'say',
]);

export function isVoiceTurn(turn: SessionTurn | undefined): boolean {
  if (!turn) return false;
  const kind = (turn.kind || '').toLowerCase();
  if (VOICE_TURN_KINDS.has(kind)) return true;
  const role = (turn.role || '').toLowerCase();
  return role === 'voice' || role === 'segment';
}

/** Rough spoken length of a line at broadcast pace (~2.6 words a second) plus
 *  a breath, clamped to something a link or segment actually runs. Mirrors
 *  speechMs in web/components/skins/shared.ts. */
export function speechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(45_000, Math.max(3_000, Math.round((words / 2.6) * 1000) + 1_200));
}

// Sanity bound on a reported clip length, so a garbage value cannot hold the
// window open; a real segment is a few minutes at most.
const MAX_CLIP_MS = 15 * 60_000;

/** How long a spoken turn lasts: the controller's measured clip length when it
 *  sends one (#1848), else speechMs's estimate. */
export function lineMs(turn: SessionTurn): number {
  const d = turn.meta?.durationMs;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= MAX_CLIP_MS) return d;
  return speechMs(turn.text || '');
}

/** Whether one of the DJ's lines is being heard at `nowMs`, and when that next
 *  changes (null = not until the feed does).
 *
 *  The latest line that has started decides. A later line still inside the
 *  buffer only schedules the next change: an unstamped turn is shown as soon as
 *  it lands, so it can sit after a line the listener is hearing right now.
 *  The previous show's carried tail (#1690) never counts: the card would put the
 *  outgoing host's words under the current DJ's name and avatar. A start too far
 *  in the future to be a real buffer (skewed clock) is ignored. */
export function talkingState(
  feed: SessionTurn[] | null | undefined,
  leadMs: number,
  nowMs: number,
): { talking: boolean; nextChangeMs: number | null } {
  const turns = feed ?? [];
  let pendingMs: number | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!isVoiceTurn(turn) || isCarriedTurn(turn)) continue;
    // airedAt is the mixer's measured start; `t` is the append time, close to
    // it, and the only stamp an older controller sends. Both are live-edge.
    const stamp =
      airedAtMs(turn) ??
      (typeof turn.t === 'number' ? turn.t : typeof turn.t === 'string' ? Date.parse(turn.t) : NaN);
    if (!Number.isFinite(stamp)) continue;
    const startMs = stamp + Math.max(0, leadMs);
    if (startMs > nowMs) {
      if (startMs - nowMs <= MAX_HOLD_MS && (pendingMs == null || startMs < pendingMs)) {
        pendingMs = startMs;
      }
      continue;
    }
    const endMs = startMs + lineMs(turn);
    if (nowMs < endMs) {
      return { talking: true, nextChangeMs: pendingMs == null ? endMs : Math.min(endMs, pendingMs) };
    }
    break;
  }
  return { talking: false, nextChangeMs: pendingMs };
}
