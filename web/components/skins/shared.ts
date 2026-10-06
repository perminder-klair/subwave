'use client';

// Pure derivations over the core-context data, shared by every skin. Keep this
// file free of JSX and styling: anything visual belongs to a skin.

import {
  eventTurnSummary,
  isCarriedTurn,
  isShowBoundary,
  turnClass,
  turnText,
  type TurnDisplayClass,
} from '@/lib/sessionFeed';
import { fmtClockMinute } from '@/lib/format';
import type { StationLocale } from '@/lib/format';
import type { ActiveShow, DjState, ListenerCount, SessionTurn, StationContext } from '@/lib/types';

/** Normalise the feed's `number | { current } | null` listener shape. */
export function listenerCountOf(
  listeners: ListenerCount | number | null,
): number | null {
  if (listeners == null) return null;
  if (typeof listeners === 'number') return listeners;
  return listeners.current ?? null;
}

export interface StationIdentity {
  /** Broadcaster name — the masthead brand. */
  stationName: string;
  /** On-air DJ name — the show's persona if one is airing, else the global DJ. */
  djName: string;
  /** Current show title, or the time-of-day period when no show is scheduled. */
  showName: string;
}

/** Centralised so the masthead facts can't drift between skins. DJ name
 *  prefers the on-air show's persona (a scheduled show can hand the hour to a
 *  guest); show name falls back to the time-of-day period. */
export function stationIdentity(
  dj: DjState | null,
  activeShow: ActiveShow | null,
  context: StationContext | null,
): StationIdentity {
  return {
    stationName: (typeof dj?.station === 'string' && dj.station) || 'SUB/WAVE',
    djName:
      activeShow?.persona?.name ||
      (typeof dj?.name === 'string' ? dj.name : '') ||
      'the DJ',
    showName: activeShow?.name || context?.time?.show || '',
  };
}

export interface BoothLine {
  text: string;
  /** Raw turn timestamp — render via turnClock(). */
  t: string | number | undefined;
  kind: TurnDisplayClass;
  /** From the previous show's tail (#1690): dim it, and label a voice line
   *  with `speaker` rather than the current DJ. */
  carried?: boolean;
  /** The show-boundary separator: draw as a rule. `kind` is 'system'. */
  boundary?: boolean;
  /** Who said a carried voice/dj line, when the controller knows. */
  speaker?: string;
}

/** The last `limit` booth-feed turns that carry displayable text, oldest
 *  first. Includes DJ reasoning and system events — skins that only want
 *  spoken lines filter on kind === 'voice'. Carry/boundary flags are only
 *  present when set, so a live line keeps its old shape. */
export function boothLines(messages: SessionTurn[], limit: number): BoothLine[] {
  const out: BoothLine[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const turn = messages[i];
    const kind = turnClass(turn);
    if (kind === 'track') continue;
    // Long event turns (the raw pick prompt) get the operator-log one-liner
    // instead of ~700 chars of agent coaching drowning the pane.
    const text = (eventTurnSummary(turn) ?? turnText(turn)).trim();
    if (!text) continue;
    const line: BoothLine = { text, t: turn?.t, kind };
    if (isShowBoundary(turn)) line.boundary = true;
    if (isCarriedTurn(turn)) {
      line.carried = true;
      const speaker = turn?.meta?.personaName;
      if (typeof speaker === 'string' && speaker) line.speaker = speaker;
    }
    out.push(line);
  }
  return out.reverse();
}

/** The DJ's most recent spoken line. The previous show's carried tail
 *  (#1690) never counts: it would put the outgoing host's words under the
 *  current DJ's name. */
export function lastVoiceLine(messages: SessionTurn[]): BoothLine | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i];
    if (turnClass(turn) !== 'voice' || isCarriedTurn(turn)) continue;
    const text = turnText(turn).trim();
    if (text) return { text, t: turn?.t, kind: 'voice' };
  }
  return null;
}

/** Timestamp of a queue/history entry. The live controller stamps history
 *  with `queuedAt`; `t` is the documented field on older payloads — accept
 *  either so clocks render on both. */
export function entryTime(
  e: { t?: string; [k: string]: unknown } | null | undefined,
): string | undefined {
  if (!e) return undefined;
  if (typeof e.t === 'string') return e.t;
  const q = e['queuedAt'];
  return typeof q === 'string' ? q : undefined;
}

/** HH:MM in the station's zone for a turn/history timestamp, '--:--' when
 *  unparseable. */
export function turnClock(
  t: string | number | undefined,
  timezone: string | null,
  locale: StationLocale,
): string {
  if (t == null) return '--:--';
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) return '--:--';
  return fmtClockMinute(date, timezone, locale);
}

/** The station-context strapline: "drive home · 16° cloudy". Pieces are
 *  omitted when absent, so a fresh install renders nothing at all. */
export function contextLine(context: StationContext | null): string {
  const parts: string[] = [];
  const vibe = context?.time?.vibe || context?.time?.show;
  if (vibe) parts.push(String(vibe));
  const w = context?.weather;
  if (w && (w.temp != null || w.condition)) {
    parts.push([w.temp != null ? `${Math.round(w.temp)}°` : '', w.condition ?? '']
      .filter(Boolean).join(' '));
  }
  return parts.join(' · ');
}

/** Genre, BPM and key, with the mood/energy cluster returned separately so a
 *  skin can accent it. */
export function trackMeta(t: {
  genre?: string | null; bpm?: number | null; musicalKey?: string | null;
  moods?: string[]; energy?: string | null;
} | null): { facts: string[]; moods: string[] } {
  if (!t) return { facts: [], moods: [] };
  const facts: string[] = [];
  if (t.genre) facts.push(t.genre.toUpperCase());
  if (typeof t.bpm === 'number' && t.bpm > 0) facts.push(`${Math.round(t.bpm)} BPM`);
  if (t.musicalKey) facts.push(t.musicalKey);
  const moods = [...(t.moods ?? [])];
  if (t.energy) moods.push(`${t.energy} energy`);
  return { facts, moods };
}

/** 0..1 progress through the current track, or null when the duration is
 *  unknown (annotate metadata carries no duration — design for both). */
export function progressRatio(elapsed: number, duration: number | undefined): number | null {
  if (!duration || duration <= 0) return null;
  return Math.min(1, Math.max(0, elapsed / duration));
}
