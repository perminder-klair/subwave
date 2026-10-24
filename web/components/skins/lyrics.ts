'use client';

// The shared lyrics hook behind a skin's Lyrics panel. It asks for the track
// the LISTENER is hearing (the feed's now-playing, a stream buffer behind the
// live edge), retries only when the station could not answer, and combines two
// timing corrections: the station's, which the operator sets once per track for
// everyone, and this device's own nudge, which never leaves the browser.

import { useCallback, useEffect, useMemo, useState } from 'react';
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

// Backoff for a station that did not answer: 5s, 10s, 20s, 40s, then every
// 60s while the panel stays open. Never sooner than the station's Retry-After.
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

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

export interface UseCurrentLyricsOptions {
  /** The listener's now-playing `subsonic_id`. */
  songId?: string | null;
  /** When the listener's audio of this track began (ms epoch, listener time). */
  trackStartedAt: number | null;
}

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

export interface CurrentLyricsState {
  status: LyricsStatus;
  lyrics: PublicLyricsPayload | null;
  activeLineIndex: number;
  deviceOffsetMs: number;
  setDeviceOffsetMs: (next: number) => void;
  station: StationOffsetControl;
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

export function useCurrentLyrics({ songId, trackStartedAt }: UseCurrentLyricsOptions): CurrentLyricsState {
  const client = useStationClient();
  const { auth, adminFetch } = useAdminAuth();
  const id = songId || null;
  const [answer, setAnswer] = useState<Answer>({ songId: null, status: 'idle', lyrics: null });
  const [nowMs, setNowMs] = useState(() => Date.now());
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
    setAnswer({ songId: id, status: 'loading', lyrics: null });
    const ask = async () => {
      const result = await client.currentLyrics(id);
      if (cancelled) return;
      if (result.kind === 'ok') {
        // The station answers for the id it was asked about; anything else
        // cannot be shown as this track's lyrics.
        setAnswer(result.payload.songId === id
          ? { songId: id, status: 'ready', lyrics: result.payload }
          : { songId: id, status: 'gone', lyrics: null });
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

  useEffect(() => {
    if (!lyrics?.synced) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [lyrics?.synced, trackStartedAt]);

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

  const elapsedMs = trackStartedAt == null ? 0 : Math.max(0, nowMs - trackStartedAt);
  const activeLineIndex = useMemo(
    () => activeLyricLineIndex(lyrics, elapsedMs, stationMs + deviceOffsetMs),
    [lyrics, elapsedMs, stationMs, deviceOffsetMs],
  );

  return {
    status: current.status,
    lyrics,
    activeLineIndex,
    deviceOffsetMs,
    setDeviceOffsetMs,
    station: {
      canTune,
      offsetMs: stationMs,
      savedMs,
      dirty: draftMs != null && draftMs !== savedMs,
      saving: savingFor != null && savingFor === id,
      error: saveError && saveError.songId === id ? saveError.message : null,
      set: setStation,
      save: saveStation,
    },
  };
}
