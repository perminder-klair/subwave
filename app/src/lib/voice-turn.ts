// "Is the DJ talking right now?" — one decision, three surfaces.
//
// The booth feed is a chat log, not an air log: a spoken turn is recognised by
// its kind/role, and it has no end stamp, so "talking" is a window that opens
// when a voice turn lands and closes TALKING_LINGER_MS later. The lock screen
// (useNowPlayingInfo), the Live Activity (useLiveActivity) and anything else
// that swaps the strip to the persona must agree on that window exactly —
// extracted here rather than copied because two copies of a timing rule drift
// (see the root CLAUDE.md on policy modules).

import type { SessionTurn } from './types';

/** How long after a voice turn the DJ still counts as on the mic. */
export const TALKING_LINGER_MS = 15_000;

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

/** Timestamp (epoch ms) of the most recent voice turn, or null. Scans from the
 *  end and stops at the first voice turn — the feed is append-ordered. */
export function lastVoiceTurnTime(feed: SessionTurn[] | undefined): number | null {
  if (!feed?.length) return null;
  for (let i = feed.length - 1; i >= 0; i--) {
    const turn = feed[i];
    if (!isVoiceTurn(turn)) continue;
    const t =
      typeof turn?.t === 'number'
        ? turn.t
        : typeof turn?.t === 'string'
          ? Date.parse(turn.t)
          : NaN;
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
