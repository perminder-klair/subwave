// Listener booth logs use GET /session. djLog remains operator diagnostics in /admin/debug.

import type { SessionTurn } from './types';

export type TurnDisplayClass = 'voice' | 'dj' | 'track' | 'system';

// Delay stamped speech by leadMs to match listener audio (#1382, #1114). Show unstamped turns
// immediately.
const MAX_HOLD_MS = 120_000;

export function airedAtMs(turn: SessionTurn | null | undefined): number | null {
  const raw = turn?.meta?.airedAt;
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

// Return audible turns and the next pending display time. Use the same rule for polls and timers.
export function splitAudibleTurns(
  messages: SessionTurn[] | null | undefined,
  leadMs: number,
  nowMs: number,
): { visible: SessionTurn[]; nextChangeMs: number | null } {
  const visible: SessionTurn[] = [];
  let nextChangeMs: number | null = null;
  for (const turn of messages || []) {
    const at = airedAtMs(turn);
    const audibleAt = at == null ? null : at + Math.max(0, leadMs);
    // An implausibly future stamp (skewed clock, absurd buffer) counts as
    // unknown: this hold fails towards "shown early", never "never shown".
    if (audibleAt == null || audibleAt <= nowMs || audibleAt - nowMs > MAX_HOLD_MS) {
      visible.push(turn);
      continue;
    }
    if (nextChangeMs == null || audibleAt < nextChangeMs) nextChangeMs = audibleAt;
  }
  return { visible, nextChangeMs };
}

export function turnClass(turn: SessionTurn | null | undefined): TurnDisplayClass {
  switch (turn?.role) {
    case 'segment': return 'voice';
    case 'dj':      return 'dj';
    case 'track':   return 'track';
    default:        return 'system';
  }
}

// "DJ" view = everything the DJ personally said or decided.
export const isDjTurn = (turn: SessionTurn | null | undefined): boolean => {
  const c = turnClass(turn);
  return c === 'voice' || c === 'dj';
};

// For a while after a hard roll GET /session leads with the outgoing show's
// tail (`meta.carried: true`) and one `kind: 'show-boundary'` separator, so a
// passive display does not go blank at a show boundary (#1690).
export function isShowBoundary(turn: SessionTurn | null | undefined): boolean {
  return turn?.role === 'event' && turn.kind === 'show-boundary';
}

export function isCarriedTurn(turn: SessionTurn | null | undefined): boolean {
  return turn?.meta?.carried === true;
}

// Separator text: the boundary moment in the client's own clock style plus the
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

// Session turns carry no id, so key off timestamp + index.
export function turnKey(turn: SessionTurn | null | undefined, i: number): string {
  return `${turn?.t || 'x'}-${i}`;
}

// `track` turns already carry a "▶ …" prefix; strip it so callers can supply
// their own marker.
export function turnText(turn: SessionTurn | null | undefined): string {
  const text = turn?.text || '';
  if (turnClass(turn) === 'track') return text.replace(/^▶\s*/, '');
  return text;
}

// The `pick` event turn is the literal ~700-char prompt posted to the DJ agent.
// Returns a one-liner for long event turns; null means render the turn as-is.
export function eventTurnSummary(turn: SessionTurn | null | undefined): string | null {
  if (turn?.role !== 'event') return null;
  const text = turn.text || '';
  if (text.length <= 160) return null;
  if (turn.kind === 'pick') {
    // Head is `Now playing "X" by Y [id: …] (after "A" by B)`: keep it, drop
    // the raw Subsonic id, reduce the instruction tail to flags.
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

// Skip pick turns for tracks not yet on air (#546). Picks are logged during the preceding track;
// voice turns qualify unless carried from the previous show (#1690).
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
