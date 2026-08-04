'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStationClient } from '@/lib/stationClient';
import type { PublicLyricsPayload } from '@/lib/types';

export const LYRIC_OFFSET_MIN_MS = -30000;
export const LYRIC_OFFSET_MAX_MS = 30000;
export const LYRIC_OFFSET_STEP_MS = 50;
export const LYRIC_OFFSET_NUDGE_MS = 100;

const OFFSET_STORAGE_KEY = 'subwave:lyrics-offset-ms';
const OFFSET_CLIENT_STORAGE_KEY = 'subwave:lyrics-offset-client-id';

// Re-ask cadence while the station is still answering for the previous track.
// The listener sits a stream-buffer behind the live edge, so the window can run
// to ~30s on a deep buffer; the limit covers it without polling indefinitely.
const STALE_RETRY_MS = 2000;
const STALE_RETRY_LIMIT = 20;

export interface UseCurrentLyricsOptions {
  /** Current Subsonic/library song id from now-playing. */
  songId?: string | null;
  /** Millisecond epoch timestamp from now-playing; used for player elapsed time. */
  trackStartedAt: number | null;
}

export interface CurrentLyricsState {
  lyrics: PublicLyricsPayload | null;
  loading: boolean;
  failed: boolean;
  /**
   * The station answered for a different track than the one we asked about, so
   * we have no verdict yet. Distinct from `failed` (the call errored) and from
   * an empty payload (the track genuinely has no lyrics) — render it as "still
   * resolving", never as "no lyrics".
   */
  stale: boolean;
  /** Add this to measured elapsed time. Positive values advance lyrics sooner. */
  offsetMs: number;
  elapsedMs: number;
  activeLineIndex: number;
  updateOffset: (next: number) => void;
}

export function clampLyricOffsetMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(LYRIC_OFFSET_MAX_MS, Math.max(LYRIC_OFFSET_MIN_MS, Math.round(value)));
}

export function formatLyricOffset(ms: number): string {
  if (ms === 0) return '0.00s';
  return `${ms > 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(2)}s`;
}

export function activeLyricLineIndex(
  lyrics: PublicLyricsPayload | null,
  elapsedMs: number,
  offsetMs: number,
): number {
  if (!lyrics?.synced) return -1;
  // Keep source lyric timestamps immutable; apply the player correction only
  // when selecting the active line.
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

function offsetStorageKey(songId: string): string {
  return `${OFFSET_STORAGE_KEY}:${songId}`;
}

function createFallbackClientId(): string {
  return `sw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function readLyricOffsetClientId(): string {
  try {
    const stored = window.localStorage.getItem(OFFSET_CLIENT_STORAGE_KEY);
    if (stored) return stored;
    const next = window.crypto?.randomUUID?.() ?? createFallbackClientId();
    window.localStorage.setItem(OFFSET_CLIENT_STORAGE_KEY, next);
    return next;
  } catch {
    return createFallbackClientId();
  }
}

function readStoredOffset(songId: string): number | null {
  try {
    const stored = window.localStorage.getItem(offsetStorageKey(songId));
    return stored == null ? null : clampLyricOffsetMs(Number(stored));
  } catch {
    return null;
  }
}

function writeStoredOffset(songId: string, offsetMs: number): void {
  try {
    window.localStorage.setItem(offsetStorageKey(songId), String(clampLyricOffsetMs(offsetMs)));
  } catch {}
}

export function useCurrentLyrics({
  songId,
  trackStartedAt,
}: UseCurrentLyricsOptions): CurrentLyricsState {
  const client = useStationClient();
  const [lyrics, setLyrics] = useState<PublicLyricsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [offsetMs, setOffsetMs] = useState(0);
  const [stale, setStale] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const clientIdRef = useRef<string>('');
  const loadedOffsetSongRef = useRef<string | null>(null);
  // What the station is known to hold for this track. The save effect writes
  // only when the local offset diverges from it, so simply loading a track
  // never PUTs the value straight back.
  const savedOffsetRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    clientIdRef.current = readLyricOffsetClientId();
  }, []);

  const updateOffset = useCallback((next: number) => {
    const clamped = clampLyricOffsetMs(next);
    setOffsetMs(clamped);
    if (songId) writeStoredOffset(songId, clamped);
  }, [songId]);

  useEffect(() => {
    let cancelled = false;
    setLyrics(null);
    setFailed(false);
    setStale(false);
    loadedOffsetSongRef.current = null;
    savedOffsetRef.current = null;
    if (!songId) {
      setLoading(false);
      setOffsetMs(0);
      return;
    }

    setLoading(true);
    const clientId = clientIdRef.current || readLyricOffsetClientId();
    clientIdRef.current = clientId;
    client.currentLyrics(clientId)
      .then((payload) => {
        if (cancelled) return;
        // `/lyrics/current` answers for whatever is on air at the live edge,
        // while the station feed deliberately holds us ~bufferSeconds behind it.
        // So a well-formed answer for another track is routine around every
        // transition, and means "ask again", not "this track has no lyrics".
        const matched = payload != null && payload.songId === songId;
        setLyrics(matched ? payload : null);
        if (matched) {
          const apiOffset = clampLyricOffsetMs(payload.offsetMs ?? 0);
          const storedOffset = readStoredOffset(songId);
          const nextOffset = apiOffset === 0 && storedOffset != null ? storedOffset : apiOffset;
          loadedOffsetSongRef.current = songId;
          // The station holds apiOffset; nextOffset may be a local value it has
          // never seen, in which case the save effect below syncs it up once.
          savedOffsetRef.current = apiOffset;
          setOffsetMs(nextOffset);
        } else {
          setOffsetMs(0);
        }
        setFailed(payload == null);
        setStale(payload != null && !matched);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [client, songId, retryTick]);

  // Keyed on songId, NOT on `stale`: each retry re-runs the fetch effect, which
  // clears `stale` on its way back out, so resetting the count there would zero
  // it every cycle and the limit below would never bite.
  useEffect(() => { retryCountRef.current = 0; }, [songId]);

  // Re-ask while the station is answering for a different track. Bounded so a
  // songId that never lines up can't leave the drawer polling forever; giving
  // up just falls through to the ordinary empty state.
  useEffect(() => {
    if (!stale || retryCountRef.current >= STALE_RETRY_LIMIT) return;
    const id = window.setTimeout(() => {
      retryCountRef.current += 1;
      setRetryTick((n) => n + 1);
    }, STALE_RETRY_MS);
    return () => window.clearTimeout(id);
  }, [stale, retryTick]);

  useEffect(() => {
    if (!songId || !lyrics?.synced || loadedOffsetSongRef.current !== songId) return;
    // Only write a real change. Without this the load itself sets `offsetMs`,
    // which re-runs this effect and PUTs the just-loaded value straight back —
    // a network write plus a row upsert per listener on every single track.
    if (savedOffsetRef.current === offsetMs) return;
    const id = window.setTimeout(() => {
      client.setCurrentLyricOffset(songId, clientIdRef.current, offsetMs)
        .then((saved) => {
          if (saved?.songId === songId && typeof saved.offsetMs === 'number') {
            const clamped = clampLyricOffsetMs(saved.offsetMs);
            savedOffsetRef.current = clamped;
            setOffsetMs(clamped);
            writeStoredOffset(songId, clamped);
          }
        });
    }, 350);
    return () => window.clearTimeout(id);
  }, [client, songId, lyrics?.synced, offsetMs]);

  useEffect(() => {
    if (!lyrics?.synced) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [lyrics?.synced, trackStartedAt]);

  const elapsedMs = trackStartedAt == null ? 0 : Math.max(0, nowMs - trackStartedAt);
  const activeLine = useMemo(
    () => activeLyricLineIndex(lyrics, elapsedMs, offsetMs),
    [lyrics, elapsedMs, offsetMs],
  );

  return {
    lyrics,
    loading,
    failed,
    stale,
    offsetMs,
    elapsedMs,
    activeLineIndex: activeLine,
    updateOffset,
  };
}
