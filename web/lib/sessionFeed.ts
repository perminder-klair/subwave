// Listener booth logs use GET /session. djLog remains operator diagnostics in /admin/debug.

import type { SessionTurn } from './types';

export type TurnDisplayClass = 'voice' | 'dj' | 'track' | 'system';

// Delay stamped speech by leadMs to match listener audio (#1382, #1114). Show unstamped turns
// immediately.
const MAX_HOLD_MS = 120_000;

/** Ceiling on the listener's buffer behind the live edge, in seconds:
 *  useStationFeed clamps the station's `stream.bufferSeconds` to it. */
export const MAX_LEAD_SECONDS = 60;

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

/** Rough spoken length of a line at broadcast pace (~2.6 words a second) plus
 *  a breath, clamped to something a link or segment actually runs. */
export function speechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(45_000, Math.max(3_000, Math.round((words / 2.6) * 1000) + 1_200));
}

// Turn kinds that map to "the DJ is on the mic". Tracks and request acks share
// the booth-feed channel but aren't voiced over the music bus.
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

export function isVoiceTurn(turn: SessionTurn | null | undefined): boolean {
  if (!turn) return false;
  const kind = (turn.kind || '').toLowerCase();
  if (VOICE_TURN_KINDS.has(kind)) return true;
  const role = (turn.role || '').toLowerCase();
  return role === 'voice' || role === 'segment';
}

// Sanity bound on a reported clip length, so a garbage value cannot hold the
// window open; a real segment is a few minutes at most.
const MAX_CLIP_MS = 15 * 60_000;

/** How long a spoken turn lasts: the controller's measured `meta.durationMs`
 *  when it sends one (#1848), else speechMs's estimate. */
export function lineMs(turn: SessionTurn): number {
  const d = turn.meta?.durationMs;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= MAX_CLIP_MS) return d;
  return speechMs(turn.text || '');
}

/** Whether one of the DJ's lines is being HEARD at `nowMs`, and when that next
 *  changes (null = not until the feed does) — the lock screen's avatar swap.
 *  The window runs from the line's live-edge stamp (`meta.airedAt`, else `t`)
 *  plus the listener's buffer, for the clip's length. A window counted from the
 *  stamp alone closes before the listener hears a word whenever the buffer
 *  (22s by default) outlasts it.
 *
 *  The latest line that has started decides; a later line still inside the
 *  buffer only schedules the next change. The previous show's carried tail
 *  never counts, and a start too far ahead to be a real buffer is ignored.
 *  The native app's lib/voice-turn.ts holds the same rule. */
export function talkingState(
  feed: SessionTurn[] | null | undefined,
  leadMs: number,
  nowMs: number,
): { talking: boolean; nextChangeMs: number | null } {
  const turns = feed ?? [];
  let pendingMs: number | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn || !isVoiceTurn(turn) || isCarriedTurn(turn)) continue;
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
