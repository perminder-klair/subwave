'use client';

// Pure derivations over the core-context data, shared by every skin. Keep this
// file free of JSX and styling: anything visual belongs to a skin.

import {
  MAX_LEAD_SECONDS,
  eventTurnSummary,
  isCarriedTurn,
  isShowBoundary,
  speechMs,
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

/** Where the station and this listener stand, collapsed to what a drawn skin
 *  draws differently: off air, tuned out (the tune-in gate), tuned in while
 *  the stream locks, or playing. */
export type ListenPhase = 'offline' | 'standby' | 'connecting' | 'live';

export function listenPhase({ offline, tunedIn, status }: {
  offline: boolean;
  tunedIn: boolean;
  status: string;
}): ListenPhase {
  if (offline) return 'offline';
  if (!tunedIn) return 'standby';
  return status === 'playing' ? 'live' : 'connecting';
}

/** The power lamp is lit: tuned in, whether or not the stream has locked. */
export function isPowered(phase: ListenPhase): boolean {
  return phase === 'connecting' || phase === 'live';
}

/** The status bar's tuning readout, shared by the drawn-instrument skins so
 *  the panel reads the same on each. */
export function tuningStatus(phase: ListenPhase, muted: boolean): string {
  switch (phase) {
    case 'offline': return 'off air';
    case 'standby': return 'standby';
    case 'connecting': return 'tuning…';
    case 'live': return muted ? 'tuned · muted' : 'tuned · locked';
  }
}

/** A track's tempo folded by octaves into [lo, hi] BPM, for motion paced on
 *  the beat. Tempo readings can come back doubled (or halved), so a reading
 *  outside the band moves by octaves rather than being clamped onto its edge.
 *  92 when the tempo is unknown. */
export function foldBpm(bpm: number | null | undefined, lo: number, hi: number): number {
  let b = typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : 92;
  while (b > hi) b /= 2;
  while (b < lo) b *= 2;
  return b;
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

// Lives in lib/sessionFeed beside talkingState, which the lock screen uses;
// re-exported so skins keep importing it from here.
export { speechMs };

// A turn is stamped near the live edge and the listener sits at most
// MAX_LEAD_SECONDS behind it, so a line older than that plus its own length
// has already been heard in full.
const ON_AIR_STALE_MS = MAX_LEAD_SECONDS * 1000;

/** How much longer the DJ's latest line is plausibly still being heard, in ms,
 *  counted from the moment it reached the feed (useStationFeed holds a stamped
 *  line until it is audible). 0 when there is no line or it is history. The
 *  feed carries no clip length, so this is an estimate from the word count. */
export function voiceOnAirMs(
  line: { text: string; t: string | number | undefined } | null,
  nowMs: number,
): number {
  if (!line) return 0;
  const dur = speechMs(line.text);
  const stamp = typeof line.t === 'number' ? line.t : typeof line.t === 'string' ? Date.parse(line.t) : NaN;
  if (Number.isFinite(stamp) && nowMs - stamp > ON_AIR_STALE_MS + dur) return 0;
  return dur;
}

/** When a queue/history entry aired: `startedAt` (queue.snapshot stamps it
 *  once the track reaches the air), else `t` from older payloads, else
 *  `queuedAt` — which is earlier than the airing, often by minutes, and which
 *  live history entries need not carry at all. undefined when none parses. */
export function entryTime(
  e: { t?: string; [k: string]: unknown } | null | undefined,
): string | undefined {
  if (!e) return undefined;
  for (const v of [e['startedAt'], e.t, e['queuedAt']]) {
    if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return v;
  }
  return undefined;
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
