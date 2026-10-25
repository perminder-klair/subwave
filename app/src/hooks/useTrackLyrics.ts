// The app's half of web/components/skins/lyrics.ts useTrackLyrics: the lyrics
// of the track the LISTENER is hearing (the feed's now-playing, already held a
// stream buffer behind the live edge), asked again only while the station
// could not answer or says a better answer is on its way, plus this device's
// timing nudge. The station's own per-track correction rides in the payload
// (`offsetMs`); the app applies it and never edits it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StationApi } from '@/lib/api';
import {
  clampLyricOffsetMs,
  lyricsRetryDelayMs,
  pendingRecheckDelayMs,
  type LyricsStatus,
} from '@/lib/lyrics';
import { loadLyricsDeviceOffset, saveLyricsDeviceOffset } from '@/lib/lyrics-prefs';
import type { PublicLyricsPayload } from '@/lib/types';

export interface TrackLyrics {
  status: LyricsStatus;
  lyrics: PublicLyricsPayload | null;
  deviceOffsetMs: number;
  setDeviceOffsetMs: (next: number) => void;
}

interface Answer {
  songId: string | null;
  status: LyricsStatus;
  lyrics: PublicLyricsPayload | null;
}

const IDLE: Answer = { songId: null, status: 'idle', lyrics: null };

/** An answer that asking again would not change. */
function settled(answer: Answer): boolean {
  if (answer.status === 'ready') return !answer.lyrics?.pending;
  return answer.status === 'disabled' || answer.status === 'gone' || answer.status === 'locked';
}

/** The lyrics of `songId`, the listener's now-playing `subsonic_id`; null asks
 *  for nothing (lyrics hidden or off, the station still locked, or nothing
 *  from the library on air). While `active` is false (the app backgrounded) no
 *  new ask starts, and the last answer is kept for when it comes back. */
export function useTrackLyrics(
  api: StationApi | null,
  songId: string | null | undefined,
  active: boolean,
): TrackLyrics {
  const id = (api && songId) || null;
  const [answer, setAnswer] = useState<Answer>(IDLE);
  // Read by the ask effect, so coming back to the foreground can tell an
  // answer worth keeping from one worth asking again. Declared first, so it
  // is current by the time that effect runs in the same commit.
  const answerRef = useRef(answer);
  useEffect(() => {
    answerRef.current = answer;
  }, [answer]);
  const [deviceOffsetMs, setDeviceOffsetState] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadLyricsDeviceOffset().then((v) => {
      if (!cancelled) setDeviceOffsetState(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!api || !id) {
      setAnswer(IDLE);
      return;
    }
    if (!active) return;
    const held = answerRef.current;
    if (held.songId === id && settled(held)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let pendingAsks = 0;
    // Coming back to a track whose answer was still improving keeps showing
    // that answer while it asks again.
    if (held.songId !== id) setAnswer({ songId: id, status: 'loading', lyrics: null });
    const ask = async () => {
      const result = await api.currentLyrics(id);
      if (cancelled) return;
      if (result.kind === 'ok') {
        // The station answers for the id it was asked about; anything else
        // cannot be shown as this track's lyrics.
        if (result.payload.songId !== id) {
          setAnswer({ songId: id, status: 'gone', lyrics: null });
          return;
        }
        // Shown at once, and asked again while the station says a better
        // answer (LRCLIB's timed lyrics) may be on its way. Once the app
        // stops asking, it stops saying it is looking.
        const delay = result.payload.pending ? pendingRecheckDelayMs(pendingAsks) : null;
        const payload = result.payload.pending && delay == null ? { ...result.payload, pending: false } : result.payload;
        setAnswer({ songId: id, status: 'ready', lyrics: payload });
        if (delay != null) {
          pendingAsks += 1;
          timer = setTimeout(ask, delay);
        }
        return;
      }
      if (result.kind !== 'unavailable') {
        setAnswer({ songId: id, status: result.kind, lyrics: null });
        return;
      }
      setAnswer((prev) => (prev.songId === id && prev.lyrics
        ? prev
        : { songId: id, status: 'unavailable', lyrics: null }));
      timer = setTimeout(ask, lyricsRetryDelayMs(attempt, result.retryAfterSec));
      attempt += 1;
    };
    void ask();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, id, active]);

  // An answer for a track we have moved on from is never shown, even for the
  // render before the effect above resets it.
  const current: Answer = answer.songId === id
    ? answer
    : { songId: id, status: id ? 'loading' : 'idle', lyrics: null };

  const setDeviceOffsetMs = useCallback((next: number) => {
    const clamped = clampLyricOffsetMs(next);
    setDeviceOffsetState(clamped);
    void saveLyricsDeviceOffset(clamped);
  }, []);

  const { status, lyrics } = current;
  return useMemo(
    () => ({ status, lyrics, deviceOffsetMs, setDeviceOffsetMs }),
    [status, lyrics, deviceOffsetMs, setDeviceOffsetMs],
  );
}

/** Where the lyric clock stands: elapsed time since the listener heard the
 *  track start, plus the station's and this device's corrections, the value
 *  each line's `startMs` is compared with. It ticks every `tickMs` only while
 *  the lines are synced and `running` (the Live page on screen, the app in the
 *  foreground), so only the component that calls it re-renders. */
export function useLyricClock(
  track: TrackLyrics,
  trackStartedAt: number | null,
  running: boolean,
  tickMs = 250,
): number {
  const synced = !!track.lyrics?.synced;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!synced || !running) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [synced, running, trackStartedAt, tickMs]);
  const elapsedMs = trackStartedAt == null ? 0 : Math.max(0, nowMs - trackStartedAt);
  return elapsedMs + (track.lyrics?.offsetMs ?? 0) + track.deviceOffsetMs;
}
