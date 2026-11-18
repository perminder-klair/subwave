'use client';

// The shared lyrics hooks behind a skin's lyrics. useTrackLyrics asks for the
// track the LISTENER is hearing (the feed's now-playing, a stream buffer behind
// the live edge), retries only when the station could not answer, and holds two
// timing corrections: the station's, which the operator sets once per track for
// everyone, and this device's own nudge, which never leaves the browser.
// useLyricClock is where in those lines the song stands. A skin calls the first
// once, so its lyrics display and its lyrics settings share one answer, and
// only the display runs the clock, so the tick re-renders nothing else.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAdminAuth } from '@/lib/adminAuth';
import { useStationClient } from '@/lib/stationClient';
import { DEFAULT_STATION_ORIGIN } from '@/lib/stationOrigin';
import {
  LYRIC_OFFSET_MAX_MS,
  LYRIC_OFFSET_MIN_MS,
  type PublicLyricsPayload,
} from '@/lib/schemas.generated';

export { LYRIC_OFFSET_MAX_MS, LYRIC_OFFSET_MIN_MS };
export const LYRIC_OFFSET_STEP_MS = 50;
export const LYRIC_OFFSET_NUDGE_MS = 100;

// One value for every track: a device's delay (Bluetooth, a receiver) is the
// same whatever is playing. A track's own mistiming is the station's to fix.
const DEVICE_OFFSET_STORAGE_KEY = 'subwave:lyrics-device-offset-ms';

// This browser's choice to see lyrics at all, shared by every skin.
const LYRICS_PREF_KEY = 'subwave:lyrics';

// How long a skin stays laid out for lyrics after they stop showing. Between
// two tracks that both have them the new lines take a moment to load, and
// dropping out of the lyrics layout for that moment would flick the page.
export const LYRICS_LAYOUT_HOLD_MS = 1500;

// Backoff for a station that did not answer: 5s, 10s, 20s, 40s, then every
// 60s while the panel stays open. Never sooner than the station's Retry-After.
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

// A station still looking a track up on LRCLIB says `pending`. It starts the
// lookup as the track goes on air, a stream buffer before the listener hears
// it, but LRCLIB often refuses a first try and the station asks again 5s and
// 15s later, so the panel keeps asking for 40s; past that it keeps what it has.
export const PENDING_RECHECK_MS = 4_000;
export const PENDING_MAX_ASKS = 10;

export type LyricsStatus =
  /** No library track to ask about. */
  | 'idle'
  | 'loading'
  | 'ready'
  /** The station or the network did not answer; the hook is asking again. */
  | 'unavailable'
  /** The operator has the Lyrics panel switched off. */
  | 'disabled'
  /** The track left the station's recent-play window before we asked. */
  | 'gone'
  /** A private station wants its password, and this browser has not got it. */
  | 'locked';

export interface StationOffsetControl {
  /** True when this browser is signed in to this station's admin console. */
  canTune: boolean;
  /** The value in force for the preview: the unsaved draft, else the saved one. */
  offsetMs: number;
  savedMs: number;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  set: (next: number) => void;
  save: () => Promise<void>;
}

/** The lyrics of the track this listener is hearing, and their corrections. */
export interface TrackLyrics {
  status: LyricsStatus;
  lyrics: PublicLyricsPayload | null;
  deviceOffsetMs: number;
  setDeviceOffsetMs: (next: number) => void;
  station: StationOffsetControl;
}

/** Synced lines, which a stage plays along with the song. */
export function syncedLyricsReady({ status, lyrics }: Pick<TrackLyrics, 'status' | 'lyrics'>): boolean {
  return status === 'ready' && !!lyrics?.synced && lyrics.lines.length > 0;
}

/** Untimed lines, which a stage shows in the same place to scroll by hand. */
export function plainLyricsReady({ status, lyrics }: Pick<TrackLyrics, 'status' | 'lyrics'>): boolean {
  return status === 'ready' && !!lyrics && !lyrics.synced && lyrics.lines.length > 0;
}

/** One line for the lyrics settings on what this track has, or why nothing. */
export function lyricsNote(track: Pick<TrackLyrics, 'status' | 'lyrics'>, shown: boolean): string {
  if (!shown) return 'Hidden on this device.';
  const { status, lyrics } = track;
  if (status === 'disabled') return 'The station has lyrics switched off.';
  if (status === 'loading') return 'Looking for lyrics…';
  if (status === 'unavailable') return 'The station isn’t answering. Trying again…';
  if (status === 'idle') return 'No lyrics right now.';
  if (status !== 'ready' || !lyrics) return 'No lyrics for this song.';
  if (syncedLyricsReady(track)) {
    return lyrics.source === 'lrclib' ? 'Synced lyrics, from LRCLIB.' : 'Synced lyrics, from the station’s library.';
  }
  if (plainLyricsReady(track)) {
    return lyrics.pending
      ? 'Untimed for now, still looking for synced ones.'
      : 'Not timed, so they don’t follow the song. Scroll through them.';
  }
  return lyrics.pending ? 'Looking for lyrics…' : 'No lyrics for this song.';
}

export function clampLyricOffsetMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(LYRIC_OFFSET_MAX_MS, Math.max(LYRIC_OFFSET_MIN_MS, Math.round(value)));
}

export function formatLyricOffset(ms: number): string {
  if (ms === 0) return '0.00s';
  return `${ms > 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(2)}s`;
}

/** The line being sung `elapsedMs` into the track, -1 before the first. */
export function activeLyricLineIndex(
  lyrics: PublicLyricsPayload | null,
  elapsedMs: number,
  offsetMs: number,
): number {
  if (!lyrics?.synced) return -1;
  // The corrections apply to the clock, never to the lines.
  const adjustedElapsedMs = Math.max(0, elapsedMs + offsetMs);
  let active = -1;
  for (let i = 0; i < lyrics.lines.length; i += 1) {
    const startMs = lyrics.lines[i]?.startMs;
    if (startMs == null) continue;
    if (startMs > adjustedElapsedMs) break;
    active = i;
  }
  return active;
}

// How a line is paced when only its start is known (LRC times lines, not
// words): roughly this long per word, never under the floor, and never past the
// next line. A line left up longer than LINE_HOLD_MS with nothing following is
// an instrumental break, so the stage rests; the line after it is teased
// TEASE_MS before it is sung.
const WORD_MS = 380;
const MIN_SUNG_MS = 900;
export const LINE_HOLD_MS = 9_000;
export const TEASE_MS = 3_500;

export interface LyricMoment {
  /** The line being sung, or -1 in an intro, a break, or after the last line. */
  current: number;
  /** How far through `current`'s words the singing is, 0 to 1. */
  progress: number;
  /** The line to show faintly after it, or -1. */
  next: number;
  /** Nothing is being sung: an intro, an instrumental break or the outro. */
  resting: boolean;
}

/** What an ambient lyrics display shows at `positionMs` on the lyric clock. */
export function lyricMoment(lyrics: PublicLyricsPayload | null, positionMs: number): LyricMoment {
  const lines = lyrics?.synced ? lyrics.lines : [];
  const at = (i: number) => lines[i]?.startMs;
  const firstTimed = lines.findIndex((l) => l.startMs != null);
  if (firstTimed < 0) return { current: -1, progress: 0, next: -1, resting: false };

  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = at(i);
    if (start == null) continue;
    if (start > positionMs) break;
    active = i;
  }
  let following = -1;
  for (let i = active + 1; i < lines.length; i++) {
    if (at(i) != null) {
      following = i;
      break;
    }
  }
  const teased = (i: number) => (i >= 0 && (at(i) as number) - positionMs <= TEASE_MS ? i : -1);

  if (active < 0) return { current: -1, progress: 0, next: teased(firstTimed), resting: true };

  const start = at(active) as number;
  const nextStart = following >= 0 ? (at(following) as number) : Number.POSITIVE_INFINITY;
  // Past the hold with the next line still far off: a break, not a held note.
  if (positionMs - start > LINE_HOLD_MS && nextStart - start > LINE_HOLD_MS) {
    return { current: -1, progress: 0, next: teased(following), resting: true };
  }
  const words = lines[active]?.text.split(/\s+/).filter(Boolean).length || 1;
  const sungMs = Math.min(Math.max(words * WORD_MS, MIN_SUNG_MS), nextStart - start);
  const progress = Math.min(1, Math.max(0, (positionMs - start) / sungMs));
  return { current: active, progress, next: following, resting: false };
}

/** This browser's choice to show lyrics, on by default. `toggle` returns the
 *  new value, so a skin can say what it did. */
export function useLyricsPreference(): { shown: boolean; toggle: () => boolean } {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(LYRICS_PREF_KEY) === '0') setShown(false);
    } catch {}
  }, []);
  const toggle = useCallback(() => {
    const next = !shown;
    setShown(next);
    try {
      localStorage.setItem(LYRICS_PREF_KEY, next ? '1' : '0');
    } catch {}
    return next;
  }, [shown]);
  return { shown, toggle };
}

/** True while `shown`, and for LYRICS_LAYOUT_HOLD_MS after it stops; never
 *  before it has started. */
export function useLingeringPresence(shown: boolean, holdMs = LYRICS_LAYOUT_HOLD_MS): boolean {
  const [lingering, setLingering] = useState(false);
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown) {
      wasShown.current = true;
      return;
    }
    if (!wasShown.current) return;
    wasShown.current = false;
    setLingering(true);
    const timer = window.setTimeout(() => setLingering(false), holdMs);
    return () => window.clearTimeout(timer);
  }, [shown, holdMs]);
  return shown || lingering;
}

/** When to ask again about an answer marked `pending`, after `asks` such asks;
 *  null once the panel should settle for what it has. */
export function pendingRecheckDelayMs(asks: number): number | null {
  return asks < PENDING_MAX_ASKS ? PENDING_RECHECK_MS : null;
}

/** How long to wait before asking again after the `attempt`th miss (0-based). */
export function lyricsRetryDelayMs(attempt: number, retryAfterSec: number | null): number {
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
  const floor = retryAfterSec != null && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
  return Math.max(backoff, Math.min(floor, RETRY_MAX_MS));
}

function readDeviceOffset(): number {
  try {
    const stored = window.localStorage.getItem(DEVICE_OFFSET_STORAGE_KEY);
    return stored == null ? 0 : clampLyricOffsetMs(Number(stored));
  } catch {
    return 0;
  }
}

function writeDeviceOffset(offsetMs: number): void {
  try {
    if (offsetMs === 0) window.localStorage.removeItem(DEVICE_OFFSET_STORAGE_KEY);
    else window.localStorage.setItem(DEVICE_OFFSET_STORAGE_KEY, String(offsetMs));
  } catch {}
}

interface Answer {
  songId: string | null;
  status: LyricsStatus;
  lyrics: PublicLyricsPayload | null;
}

/** The lyrics of `songId`, the listener's now-playing `subsonic_id`; null asks
 *  for nothing (lyrics hidden, or nothing from the library on air). */
export function useTrackLyrics(songId?: string | null): TrackLyrics {
  const client = useStationClient();
  const { auth, adminFetch } = useAdminAuth();
  const id = songId || null;
  const [answer, setAnswer] = useState<Answer>({ songId: null, status: 'idle', lyrics: null });
  const [deviceOffsetMs, setDeviceOffsetState] = useState(0);
  const [draft, setDraft] = useState<{ songId: string; offsetMs: number } | null>(null);
  // Keyed by track, like the draft: a save still in flight when the song
  // changes must not disable, or report its failure on, the next song's controls.
  const [savingFor, setSavingFor] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ songId: string; message: string } | null>(null);

  useEffect(() => {
    setDeviceOffsetState(readDeviceOffset());
  }, []);

  useEffect(() => {
    setDraft(null);
    setSaveError(null);
    if (!id) {
      setAnswer({ songId: null, status: 'idle', lyrics: null });
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    let pendingAsks = 0;
    setAnswer({ songId: id, status: 'loading', lyrics: null });
    const ask = async () => {
      const result = await client.currentLyrics(id);
      if (cancelled) return;
      if (result.kind === 'ok') {
        // The station answers for the id it was asked about; anything else
        // cannot be shown as this track's lyrics.
        if (result.payload.songId !== id) {
          setAnswer({ songId: id, status: 'gone', lyrics: null });
          return;
        }
        // Shown at once, and asked again while the station says a better
        // answer (LRCLIB's timed lyrics) may be on its way. Once the panel
        // stops asking, it stops saying it is looking.
        const delay = result.payload.pending ? pendingRecheckDelayMs(pendingAsks) : null;
        const payload = result.payload.pending && delay == null ? { ...result.payload, pending: false } : result.payload;
        setAnswer({ songId: id, status: 'ready', lyrics: payload });
        if (delay != null) {
          pendingAsks += 1;
          timer = window.setTimeout(ask, delay);
        }
        return;
      }
      if (result.kind !== 'unavailable') {
        setAnswer({ songId: id, status: result.kind, lyrics: null });
        return;
      }
      setAnswer({ songId: id, status: 'unavailable', lyrics: null });
      timer = window.setTimeout(ask, lyricsRetryDelayMs(attempt, result.retryAfterSec));
      attempt += 1;
    };
    void ask();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [client, id]);

  // An answer for a track we have moved on from is never shown, even for the
  // render before the effect above resets it.
  const current = answer.songId === id ? answer : { songId: id, status: id ? 'loading' as const : 'idle' as const, lyrics: null };
  const lyrics = current.lyrics;

  const setDeviceOffsetMs = useCallback((next: number) => {
    const clamped = clampLyricOffsetMs(next);
    setDeviceOffsetState(clamped);
    writeDeviceOffset(clamped);
  }, []);

  // The operator control is offered only for the station this page belongs
  // to: the admin credential in this browser is that install's, and a player
  // pointed at another station must never send it there.
  const canTune = !!auth && client.origin.apiUrl === DEFAULT_STATION_ORIGIN.apiUrl;
  const savedMs = lyrics?.offsetMs ?? 0;
  const draftMs = draft && draft.songId === id ? draft.offsetMs : null;
  const stationMs = draftMs ?? savedMs;

  const setStation = useCallback((next: number) => {
    if (!id) return;
    setSaveError(null);
    setDraft({ songId: id, offsetMs: clampLyricOffsetMs(next) });
  }, [id]);

  const saveStation = useCallback(async () => {
    if (!id || draftMs == null) return;
    setSavingFor(id);
    setSaveError(null);
    const fail = (message: string) => setSaveError({ songId: id, message });
    try {
      const res = await adminFetch(`/lyrics/offsets/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMs: draftMs }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        fail(res.status === 401 ? 'Sign in to the admin console again to save.' : body?.error || 'Could not save.');
        return;
      }
      setAnswer((prev) => (prev.songId === id && prev.lyrics
        ? { ...prev, lyrics: { ...prev.lyrics, offsetMs: draftMs } }
        : prev));
      setDraft((prev) => (prev?.songId === id ? null : prev));
    } catch {
      fail('Could not reach the station.');
    } finally {
      setSavingFor((prev) => (prev === id ? null : prev));
    }
  }, [adminFetch, draftMs, id]);

  // Stable while nothing changes, so the memoized displays and settings that
  // take it re-render only when the answer or a correction does.
  const status = current.status;
  const dirty = draftMs != null && draftMs !== savedMs;
  const saving = savingFor != null && savingFor === id;
  const error = saveError && saveError.songId === id ? saveError.message : null;
  return useMemo(() => ({
    status,
    lyrics,
    deviceOffsetMs,
    setDeviceOffsetMs,
    station: {
      canTune,
      offsetMs: stationMs,
      savedMs,
      dirty,
      saving,
      error,
      set: setStation,
      save: saveStation,
    },
  }), [status, lyrics, deviceOffsetMs, setDeviceOffsetMs, canTune, stationMs, savedMs, dirty, saving, error, setStation, saveStation]);
}

/** Where the lyric clock stands: elapsed time plus both corrections, the value
 *  each line's `startMs` is compared with. It ticks every `tickMs` while the
 *  lines are synced, so only the component that calls it re-renders. */
export function useLyricClock(track: TrackLyrics, trackStartedAt: number | null, tickMs = 500): number {
  const synced = !!track.lyrics?.synced;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!synced) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), tickMs);
    return () => window.clearInterval(timer);
  }, [synced, trackStartedAt, tickMs]);
  const elapsedMs = trackStartedAt == null ? 0 : Math.max(0, nowMs - trackStartedAt);
  return elapsedMs + track.station.offsetMs + track.deviceOffsetMs;
}
