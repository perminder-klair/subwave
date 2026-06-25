// Shared display helpers for live-session turns served by GET /session.
//
// A session turn is { t, role, kind, text, meta }. The live session is the
// single source of truth for the booth log everywhere it's shown to people:
// the player Booth feed, the player broadcast ticker, and /admin/dash. The
// controller's in-memory `djLog` is operator diagnostics only — it stays
// behind /admin/debug.
//
// role → display class:
//   voice  — spoken on-air verbatim (links, station IDs, time, weather)
//   dj     — the DJ agent's pick / request reasoning (the "thinking")
//   track  — a track that aired
//   system — system events (session start, pick prompts, restarts)

import type { SessionTurn } from './types';

export type TurnDisplayClass = 'voice' | 'dj' | 'track' | 'system';

export function turnClass(turn: SessionTurn | null | undefined): TurnDisplayClass {
  switch (turn?.role) {
    case 'segment': return 'voice';
    case 'dj':      return 'dj';
    case 'track':   return 'track';
    default:        return 'system';
  }
}

export const isVoice = (turn: SessionTurn | null | undefined): boolean =>
  turnClass(turn) === 'voice';

// "DJ" view = everything the DJ personally said or decided.
export const isDjTurn = (turn: SessionTurn | null | undefined): boolean => {
  const c = turnClass(turn);
  return c === 'voice' || c === 'dj';
};

// Session turns carry no id — derive a stable React key from timestamp + index.
export function turnKey(turn: SessionTurn | null | undefined, i: number): string {
  return `${turn?.t || 'x'}-${i}`;
}

// Plain display text. `track` turns already carry a "▶ …" prefix in their
// text; strip it so callers can supply their own marker.
export function turnText(turn: SessionTurn | null | undefined): string {
  const text = turn?.text || '';
  if (turnClass(turn) === 'track') return text.replace(/^▶\s*/, '');
  return text;
}

// The single voice/dj turn to surface as the DJ "thinking" line under the
// now-playing block. Walk newest→oldest and skip `dj`/pick turns whose
// `meta.trackId` is for a track other than what's on air: a pick turn is
// written at the *previous* track's start, so its trackId is the track to play
// NEXT, not the one playing now — showing it under now-playing reads as "this
// song's reasoning" when it isn't (#546). Voice/segment turns (aired links,
// station IDs, weather) carry no trackId and are whatever was last spoken on
// air, so they always qualify — meaning the back-announce link that aired as
// this track started wins, falling back to this track's own pick reason on a
// silent transition. A null/unknown currentTrackId yields the latest voice turn
// (no pick can be confirmed as "this song").
export function selectThinkingTurn(
  feed: SessionTurn[] | null | undefined,
  currentTrackId: string | null = null,
): SessionTurn | null {
  if (!feed?.length) return null;
  for (let i = feed.length - 1; i >= 0; i--) {
    const turn = feed[i];
    const cls = turnClass(turn);
    if (!turn?.text || (cls !== 'voice' && cls !== 'dj')) continue;
    const trackId = turn.meta?.trackId as string | undefined;
    if (cls === 'dj' && trackId && trackId !== currentTrackId) continue;
    return turn;
  }
  return null;
}
