'use client';

// Small helpers shared by skin implementations — pure derivations over the
// core-context data so each skin renders the same station facts its own way.
// Keep this file free of JSX and styling: anything visual belongs to a skin.

import {
  eventTurnSummary,
  turnClass,
  turnText,
  type TurnDisplayClass,
} from '@/lib/sessionFeed';
import { fmtClockMinute } from '@/lib/format';
import type { StationLocale } from '@/lib/format';
import type { ListenerCount, SessionTurn, StationContext } from '@/lib/types';

/** Normalise the feed's `number | { current } | null` listener shape. */
export function listenerCountOf(
  listeners: ListenerCount | number | null,
): number | null {
  if (listeners == null) return null;
  if (typeof listeners === 'number') return listeners;
  return listeners.current ?? null;
}

export interface BoothLine {
  text: string;
  /** Raw turn timestamp — render via turnClock(). */
  t: string | number | undefined;
  kind: TurnDisplayClass;
}

/** The last `limit` booth-feed turns that carry displayable text, oldest
 *  first. Includes DJ reasoning and system events — skins that only want
 *  spoken lines filter on kind === 'voice'. */
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
    out.push({ text, t: turn?.t, kind });
  }
  return out.reverse();
}

/** The DJ's most recent spoken line — the voice of the station. */
export function lastVoiceLine(messages: SessionTurn[]): BoothLine | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i];
    if (turnClass(turn) !== 'voice') continue;
    const text = turnText(turn).trim();
    if (text) return { text, t: turn?.t, kind: 'voice' };
  }
  return null;
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
 *  omitted when absent so a fresh install renders nothing rather than
 *  placeholder noise. */
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

/** Nerd-metadata tokens for the current track: genre, BPM, key — and the
 *  accent-worthy mood/energy cluster separately. */
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
