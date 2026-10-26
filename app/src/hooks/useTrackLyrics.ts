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
  lyricsSettled,
  lyricsStep,
  type LyricsAnswer,
  type TrackAnswer,
} from '@/lib/lyrics';
import { loadLyricsDeviceOffset, saveLyricsDeviceOffset } from '@/lib/lyrics-prefs';

export interface TrackLyrics extends LyricsAnswer {
  deviceOffsetMs: number;
  setDeviceOffsetMs: (next: number) => void;
}

const IDLE: TrackAnswer = { songId: null, status: 'idle', lyrics: null };

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
  const [answer, setAnswer] = useState<TrackAnswer>(IDLE);
  // Read by the ask effect, so coming back to the foreground can tell an
  // answer worth keeping from one worth asking again. Declared first, so it
  // is current by the time that effect runs in the same commit.
  const answerRef = useRef(answer);
  useEffect(() => {
    answerRef.current = answer;
  }, [answer]);
  const [deviceOffsetMs, setDeviceOffsetState] = useState(0);
  // The station and track the ask effect last ran for, to spot a track id
  // left over from the station before a switch.
  const lastRunRef = useRef({ api, id });
  // Rechecks of a pending answer made for the current track, across runs of
  // the ask effect: the PENDING_MAX_ASKS cap is per track, not per trip to the
  // foreground.
  const rechecksRef = useRef({ songId: null as string | null, asks: 0 });

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
    const last = lastRunRef.current;
    lastRunRef.current = { api, id };
    if (!api || !id) {
      setAnswer(IDLE);
      return;
    }
    if (!active) return;
    // A track id means something only to the station it came from. For the
    // render after a station switch the feed still holds the old station's
    // track, until its reset clears it (a new track always arrives through
    // null), and a private station would spend an attempt refusing it.
    if (last.api !== api && last.id === id) return;
    const held = answerRef.current;
    if (held.songId === id && lyricsSettled(held)) return;
    if (rechecksRef.current.songId !== id) rechecksRef.current = { songId: id, asks: 0 };
    const rechecks = rechecksRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The backoff starts over on each run: coming back to the foreground asks
    // at once.
    let attempt = 0;
    // Coming back to a track whose answer was still improving keeps showing
    // that answer while it asks again.
    if (held.songId !== id) setAnswer({ songId: id, status: 'loading', lyrics: null });
    const ask = async () => {
      const result = await api.currentLyrics(id);
      if (cancelled) return;
      const step = lyricsStep(id, result, attempt, rechecks.asks);
      setAnswer(step.answer);
      if (step.askAgainMs == null) return;
      if (step.recheck) rechecks.asks += 1;
      else attempt += 1;
      timer = setTimeout(ask, step.askAgainMs);
    };
    void ask();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, id, active]);

  // An answer for a track we have moved on from is never shown, even for the
  // render before the effect above resets it.
  const current: TrackAnswer = answer.songId === id
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
  tickMs = 500,
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
