// Poll all endpoints every 5s in the foreground; only /now-playing and
// /session every 30s during background playback. Preserve unchanged payload
// identities.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppActive } from '@/hooks/useAppActive';
import type { StationApi } from '@/lib/api';
import { pollAsync } from '@/lib/poll';
import { DEFAULT_STATION_LOCALE, type StationLocale } from '@/lib/format';
import { MAX_LEAD_SECONDS, splitAudibleTurns } from '@/lib/sessionFeed';
import type {
  ActiveShow,
  DjState,
  ListenerCount,
  NowPlayingResponse,
  NowPlayingTrack,
  SessionPayload,
  StationContext,
  StationState,
  StreamInfo,
} from '@/lib/types';

export interface StationFeed {
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  dj: DjState | null;
  activeShow: ActiveShow | null;
  listeners: ListenerCount | number | null;
  streamOnline: boolean | null;
  /** Which optional mounts are live; drives the stream-format picker. */
  streamInfo: StreamInfo | null;
  /** Cumulative since-boot LLM token total. */
  llmTokens: number | null;
  state: StationState;
  /** Spoken turns stamped with `meta.airedAt` are held until this listener
   *  can hear them (#1382); unstamped turns pass straight through. */
  session: SessionPayload;
  /** How far this listener sits behind the live edge, in ms: the station's
   *  stream.bufferSeconds clamped to 0–60s, 0 before the first payload. */
  leadMs: number;
  elapsed: number;
  progress: number;
  /** Epoch ms when the on-display track became audible to this listener: the
   *  controller's live-edge stamp shifted by stream.bufferSeconds. `elapsed` is
   *  the same clock ticked in JS, and only while foregrounded — background
   *  surfaces (the Live Activity) must key off this absolute stamp. */
  trackStartedAt: number | null;
  /** Station IANA timezone. Render on-air timestamps in it so they match what
   *  the DJ speaks (#418). */
  timezone: string | null;
  locale: StationLocale;
}

const EMPTY_STATE: StationState = { upcoming: [], history: [], djLog: [] };
const EMPTY_SESSION: SessionPayload = { session: null, messages: [] };
// Consecutive offline polls required before believing it (#463/#466) —
// PlayerScreen stops playback on offline, so a transient blip must not count.
const OFFLINE_CONFIRM_POLLS = 4;

export function useStationFeed(
  api: StationApi | null,
  opts?: { backgroundPoll?: boolean },
): StationFeed {
  const backgroundPoll = opts?.backgroundPoll ?? false;
  const [nowPlaying, setNowPlaying] = useState<NowPlayingTrack | null>(null);
  const [context, setContext] = useState<StationContext | null>(null);
  const [dj, setDj] = useState<DjState | null>(null);
  const [activeShow, setActiveShow] = useState<ActiveShow | null>(null);
  const [listeners, setListeners] = useState<ListenerCount | number | null>(null);
  const [streamOnline, setStreamOnline] = useState<boolean | null>(null);
  const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
  const [llmTokens, setLlmTokens] = useState<number | null>(null);
  const [state, setState] = useState<StationState>(EMPTY_STATE);
  const [session, setSession] = useState<SessionPayload>(EMPTY_SESSION);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [locale, setLocale] = useState<StationLocale>(DEFAULT_STATION_LOCALE);
  const [elapsed, setElapsed] = useState(0);
  const trackStartRef = useRef<number | null>(null);
  // trackStartRef mirrored into state, so a native surface can tick its own
  // clock off one update instead of the foreground-only `elapsed`.
  const [trackStartedAt, setTrackStartedAt] = useState<number | null>(null);
  const offlinePollsRef = useRef(0);
  const appActive = useAppActive();
  // Track currently on display, which lags the controller's latest by the
  // listener's buffer until the audio catches up.
  const lastTrackKeyRef = useRef<string | null>(null);
  // Listener buffer depth in ms (stream.bufferSeconds); 0 until the first
  // payload, which degrades to live-edge behaviour. The ref serves the poll
  // and hold timers; the state is for consumers.
  const leadMsRef = useRef(0);
  const [leadMs, setLeadMs] = useState(0);
  const promoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Same hold for the DJ's spoken lines (#1382): raw /session payload in a ref,
  // its audible subset in `session`.
  const rawSessionRef = useRef<SessionPayload>(EMPTY_SESSION);
  const voiceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-field payload signatures: skip the setState, keeping the previous
  // object identity, when a poll returns identical data.
  const sigRef = useRef<Record<string, string>>({});
  const setIfChanged = useCallback(<T,>(key: string, value: T, set: (v: T) => void) => {
    const sig = JSON.stringify(value) ?? 'null';
    if (sigRef.current[key] === sig) return;
    sigRef.current[key] = sig;
    set(value);
  }, []);

  // Re-derive the audible turns and re-arm for the next one, so a held line
  // lands on time rather than on the poll grid. Not owned by the poll effect:
  // that re-runs on every foreground/background flip, and a line held when the
  // app backgrounds must still land behind the lock screen.
  const applySession = useCallback(() => {
    const run = () => {
      const raw = rawSessionRef.current;
      const now = Date.now();
      const { visible, nextChangeMs } = splitAudibleTurns(raw.messages, leadMsRef.current, now);
      setIfChanged('session', { session: raw.session, messages: visible }, setSession);
      if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
      voiceTimerRef.current =
        nextChangeMs == null ? null : setTimeout(run, Math.max(0, nextChangeMs - now));
    };
    run();
  }, [setIfChanged]);

  useEffect(() => () => {
    if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
  }, []);

  // On station switch, drop the previous station's data (stale signatures would
  // otherwise suppress the first updates). Must be declared before the poll
  // effect so the reset lands before the new station's first tick.
  const prevApiRef = useRef(api);
  useEffect(() => {
    if (prevApiRef.current === api) return;
    prevApiRef.current = api;
    sigRef.current = {};
    trackStartRef.current = null;
    setTrackStartedAt(null);
    offlinePollsRef.current = 0;
    // A held track switch from the old station would stamp the new station's
    // clock with a foreign start time.
    lastTrackKeyRef.current = null;
    leadMsRef.current = 0;
    setLeadMs(0);
    if (promoteTimerRef.current) {
      clearTimeout(promoteTimerRef.current);
      promoteTimerRef.current = null;
    }
    // Likewise a held line from the old station must not land on the new one.
    rawSessionRef.current = EMPTY_SESSION;
    if (voiceTimerRef.current) {
      clearTimeout(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    setNowPlaying(null);
    setContext(null);
    setDj(null);
    setActiveShow(null);
    setListeners(null);
    setStreamOnline(null);
    setStreamInfo(null);
    setLlmTokens(null);
    setState(EMPTY_STATE);
    setSession(EMPTY_SESSION);
    setTimezone(null);
    setLocale(DEFAULT_STATION_LOCALE);
    setElapsed(0);
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const background = !appActive;
    if (background && !backgroundPoll) return;

    // `current` is /state's live-edge view, absent on the background poll (which
    // skips /state) and on a failed /state leg.
    const applyNowPlaying = (npRes: NowPlayingResponse, current?: StationState['current']) => {
      const np = npRes.nowPlaying;
      // Buffer depth first; everything below is measured against it. Clamped to
      // 0-60s so a bad value can't park the clock in the far future.
      const bufSec = npRes.stream?.bufferSeconds;
      if (typeof bufSec === 'number' && Number.isFinite(bufSec)) {
        leadMsRef.current = Math.min(Math.max(bufSec, 0), MAX_LEAD_SECONDS) * 1000;
        setLeadMs(leadMsRef.current);
      }
      const trackKey = np ? `${np.title}\0${np.artist}` : null;

      // Prefer the controller's live-edge stamp over "first seen by this
      // client": a backgrounded app polls every 30s and would start late.
      let serverStart = NaN;
      if (np?.title && current && current.title === np.title && current.startedAt) {
        const t = Date.parse(current.startedAt);
        if (Number.isFinite(t) && t <= Date.now()) serverStart = t;
      }
      // Shift into listener-time: the audio arrives leadMs after the live edge.
      // With no server stamp, fall back to first-seen (no offset); the next
      // foreground tick carries /state and repairs it in the converge branch.
      const audibleAt = Number.isFinite(serverStart) ? serverStart + leadMsRef.current : Date.now();

      if (trackKey !== lastTrackKeyRef.current) {
        const commit = () => {
          promoteTimerRef.current = null;
          lastTrackKeyRef.current = trackKey;
          trackStartRef.current = audibleAt;
          setTrackStartedAt(audibleAt);
          setIfChanged('nowPlaying', np, setNowPlaying);
        };
        const wait = audibleAt - Date.now();
        if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
        // Show immediately when the audio is already out, when the stream drops,
        // or on the first payload (a cold start has no earlier track to hold).
        if (wait <= 0 || trackKey == null || lastTrackKeyRef.current == null) commit();
        else promoteTimerRef.current = setTimeout(commit, wait);
      } else {
        // Same track: converge on the server stamp, ignoring drift under 2.5s.
        if (Number.isFinite(serverStart)) {
          const prev = trackStartRef.current;
          if (prev == null || Math.abs(audibleAt - prev) > 2500) {
            trackStartRef.current = audibleAt;
            setTrackStartedAt(audibleAt);
          }
        }
        setIfChanged('nowPlaying', np, setNowPlaying);
      }
      setIfChanged('context', npRes.context, setContext);
      if (npRes.dj) setIfChanged('dj', npRes.dj, setDj);
      setIfChanged('activeShow', npRes.activeShow ?? npRes.context?.activeShow ?? null, setActiveShow);
      if (npRes.listeners != null) setIfChanged('listeners', npRes.listeners, setListeners);
      if (typeof npRes.streamOnline === 'boolean') {
        if (npRes.streamOnline) {
          offlinePollsRef.current = 0;
          setStreamOnline(true);
        } else {
          offlinePollsRef.current += 1;
          if (offlinePollsRef.current >= OFFLINE_CONFIRM_POLLS) setStreamOnline(false);
        }
      }
      if (npRes.stream) setIfChanged('streamInfo', npRes.stream, setStreamInfo);
      if (typeof npRes.llmTokens === 'number') setIfChanged('llmTokens', npRes.llmTokens, setLlmTokens);
      if (typeof npRes.timezone === 'string' && npRes.timezone) setTimezone(npRes.timezone);
      if (npRes.locale === 'en-US' || npRes.locale === 'en-GB') setLocale(npRes.locale);
    };

    const applySessionPayload = (se: PromiseSettledResult<SessionPayload>) => {
      if (se.status === 'fulfilled' && se.value && Array.isArray(se.value.messages)) {
        rawSessionRef.current = se.value;
        applySession();
      }
    };

    const tick = async (signal: AbortSignal) => {
      if (background) {
        // Only what the lock screen and Live Activity show: the track, and the
        // booth feed their "DJ on the mic" swap reads (~5KB gzipped a poll).
        const [np, se] = await Promise.allSettled([api.nowPlaying(signal), api.session(signal)]);
        if (signal.aborted) return;
        if (np.status === 'fulfilled') applyNowPlaying(np.value);
        applySessionPayload(se);
        return;
      }
      // Keep successful endpoint results when another request fails.
      const [np, st, se] = await Promise.allSettled([
        api.nowPlaying(signal),
        api.state(signal),
        api.session(signal),
      ]);
      if (signal.aborted) return;
      // /state's `current` carries the live-edge stamp applyNowPlaying needs to
      // place the track in listener-time.
      if (np.status === 'fulfilled') {
        applyNowPlaying(np.value, st.status === 'fulfilled' ? st.value?.current : undefined);
      }
      if (st.status === 'fulfilled') setIfChanged('state', st.value, setState);
      applySessionPayload(se);
    };
    const stopPolling = pollAsync(tick, background ? 30000 : 5000);
    return () => {
      stopPolling();
      // Must not reset lastTrackKeyRef: this effect re-runs on every
      // foreground/background flip, and forgetting the on-display track would
      // make the next tick re-stamp the clock as if it were a cold start.
      if (promoteTimerRef.current) {
        clearTimeout(promoteTimerRef.current);
        promoteTimerRef.current = null;
      }
    };
  }, [api, appActive, backgroundPoll, setIfChanged, applySession]);

  useEffect(() => {
    if (!appActive) return;
    const update = () => {
      if (trackStartRef.current) {
        // Clamped at 0: trackStartRef is listener-time and sits in the future
        // while the track is still inside the buffer.
        setElapsed(Math.max(0, Math.floor((Date.now() - trackStartRef.current) / 1000)));
      }
    };
    update(); // catch up immediately on foreground
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [appActive]);

  const duration = nowPlaying?.duration ?? 0;
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

  return {
    nowPlaying,
    context,
    dj,
    activeShow,
    listeners,
    streamOnline,
    streamInfo,
    llmTokens,
    state,
    session,
    leadMs,
    elapsed,
    progress,
    trackStartedAt,
    timezone,
    locale,
  };
}
