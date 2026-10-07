// Display helpers for GET /session turns. Source of truth is
// web/lib/sessionFeed.ts; keep in sync. Classes: voice (spoken on air),
// dj (pick/request reasoning), track (aired), system.

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

export const isDjTurn = (turn: SessionTurn | null | undefined): boolean => {
  const c = turnClass(turn);
  return c === 'voice' || c === 'dj';
};

// After a hard roll GET /session briefly leads with the outgoing show's tail
// (`meta.carried: true`) and one `kind: 'show-boundary'` separator (#1690).
export function isShowBoundary(turn: SessionTurn | null | undefined): boolean {
  return turn?.role === 'event' && turn.kind === 'show-boundary';
}

export function isCarriedTurn(turn: SessionTurn | null | undefined): boolean {
  return turn?.meta?.carried === true;
}

// Separator text: the boundary moment in the client's clock style plus the
// incoming show (or host). Falls back to the server-rendered `text`.
export function showBoundaryLabel(
  turn: SessionTurn | null | undefined,
  clock: (at: string) => string,
): string {
  const b = turn?.meta?.boundary as { at?: unknown; show?: unknown; persona?: unknown } | undefined;
  const at = typeof b?.at === 'string' && Number.isFinite(Date.parse(b.at)) ? b.at : null;
  if (!at) return turn?.text || '';
  const name = (typeof b?.show === 'string' && b.show)
    || (typeof b?.persona === 'string' && b.persona)
    || 'On air';
  return `${clock(at)} · ${name}`;
}

export function turnKey(turn: SessionTurn | null | undefined, i: number): string {
  return `${turn?.t || 'x'}-${i}`;
}

export function turnText(turn: SessionTurn | null | undefined): string {
  const text = turn?.text || '';
  if (turnClass(turn) === 'track') return text.replace(/^▶\s*/, '');
  return text;
}

// Pick meta.trackId refers to the next song; skip other track ids (#546).
// Voice turns have no trackId and can override the pick reason.
// Carried turns belong to the previous show and never qualify (#1690).
export function selectThinkingTurn(
  feed: SessionTurn[] | null | undefined,
  currentTrackId: string | null = null,
): SessionTurn | null {
  if (!feed?.length) return null;
  for (let i = feed.length - 1; i >= 0; i--) {
    const turn = feed[i];
    const cls = turnClass(turn);
    if (!turn?.text || (cls !== 'voice' && cls !== 'dj')) continue;
    if (isCarriedTurn(turn)) continue;
    const trackId = turn.meta?.trackId as string | undefined;
    if (cls === 'dj' && trackId && trackId !== currentTrackId) continue;
    return turn;
  }
  return null;
}
