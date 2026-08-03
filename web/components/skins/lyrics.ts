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

export interface UseCurrentLyricsOptions {
  songId?: string | null;
  trackStartedAt: number | null;
}

export interface CurrentLyricsState {
  lyrics: PublicLyricsPayload | null;
  loading: boolean;
  failed: boolean;
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
  const clientIdRef = useRef<string>('');
  const loadedOffsetSongRef = useRef<string | null>(null);

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
    loadedOffsetSongRef.current = null;
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
        const nextLyrics = payload?.songId === songId ? payload : null;
        setLyrics(nextLyrics);
        if (nextLyrics) {
          const apiOffset = clampLyricOffsetMs(nextLyrics.offsetMs ?? 0);
          const storedOffset = readStoredOffset(songId);
          const nextOffset = apiOffset === 0 && storedOffset != null ? storedOffset : apiOffset;
          loadedOffsetSongRef.current = songId;
          setOffsetMs(nextOffset);
        } else {
          setOffsetMs(0);
        }
        setFailed(payload == null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [client, songId]);

  useEffect(() => {
    if (!songId || !lyrics?.synced || loadedOffsetSongRef.current !== songId) return;
    const id = window.setTimeout(() => {
      client.setCurrentLyricOffset(songId, clientIdRef.current, offsetMs)
        .then((saved) => {
          if (saved?.songId === songId && typeof saved.offsetMs === 'number') {
            const clamped = clampLyricOffsetMs(saved.offsetMs);
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
    offsetMs,
    elapsedMs,
    activeLineIndex: activeLine,
    updateOffset,
  };
}
