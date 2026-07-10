// Shared display helpers for live-session turns served by GET /session.
// SOURCE OF TRUTH: web/web/lib/sessionFeed.ts — kept in sync (pure functions).
//
//   voice  — spoken on-air verbatim (links, station IDs, time, weather)
//   dj     — the DJ agent's pick / request reasoning (the "thinking")
//   track  — a track that aired
//   system — system events

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

export const isDjTurn = (turn: SessionTurn | null | undefined): boolean => {
  const c = turnClass(turn);
  return c === 'voice' || c === 'dj';
};

export function turnKey(turn: SessionTurn | null | undefined, i: number): string {
  return `${turn?.t || 'x'}-${i}`;
}

export function turnText(turn: SessionTurn | null | undefined): string {
  const text = turn?.text || '';
  if (turnClass(turn) === 'track') return text.replace(/^▶\s*/, '');
  return text;
}

// Operator-log summary for long `event` turns (#958). The `pick` event turn is
// the literal prompt posted to the DJ agent — ~700 chars of link/clock/
// transition coaching that the model needs verbatim but that drowns a log when
// rendered raw. Returns a one-liner for long event turns; null means "render
// the turn as-is". (The listener Booth hides event/system turns entirely — this
// exists for any surface that shows the full session, mirroring the web.)
export function eventTurnSummary(turn: SessionTurn | null | undefined): string | null {
  if (turn?.role !== 'event') return null;
  const text = turn.text || '';
  if (text.length <= 160) return null;
  if (turn.kind === 'pick') {
    // Head is `Now playing "X" by Y [id: …] (after "A" by B)` — keep it, drop
    // the raw Subsonic id, and reduce the instruction tail to flags.
    const head = (text.split('. Pick the track to play next.')[0] ?? text)
      .replace(/\s*\[id:[^\]]*\]/g, '');
    const parts = [
      `${head} → pick next`,
      text.includes('Stay silent') ? 'silent' : 'with link',
    ];
    if (text.includes('Set "transition"')) parts.push('effects nudge');
    return parts.join(' · ');
  }
  const firstSentence = text.match(/^[^.!?]*[.!?]/)?.[0] || text.slice(0, 140);
  return `${firstSentence.trim()} …`;
}

// The single voice/dj turn to surface as the DJ "thinking" line under the
// now-playing block. Skips `dj`/pick turns whose meta.trackId is for a track
// other than what's on air — a pick turn is written at the previous track's
// start, so its trackId is the NEXT track, not the one playing now (#546).
// Voice turns carry no trackId, so the aired back-announce link wins, falling
// back to this track's own pick reason on a silent transition.
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
