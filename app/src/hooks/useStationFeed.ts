// Native port of web/web/hooks/useStationFeed.ts.
//
// 5s polling of /now-playing + /state + /session, plus a 1s elapsed tick that
// resets on track-change. The base URL comes from the StationApi passed in
// (runtime), not a build-time env. Two native-specific deviations:
//   * polling winds down while the app is backgrounded: nothing at all when
//     idle, and a 30s /now-playing-only poll while tuned in (just enough to
//     keep the lock-screen metadata pushed by useNowPlayingInfo current —
//     /state + /session feed UI nobody can see). The UI catches up with an
//     immediate full tick on foreground.
//   * unchanged payloads keep their previous object identity, so consumers'
//     useMemo/React.memo actually hold between polls.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useAppActive } from '@/hooks/useAppActive';
import type { StationApi } from '@/lib/api';
import { DEFAULT_STATION_LOCALE, type StationLocale } from '@/lib/format';
import type {
  ActiveShow,
  DjState,
  ListenerCount,
  NowPlayingResponse,
  NowPlayingTrack,
  PublicStreamInfo,
  SessionPayload,
  StationContext,
  StationState,
} from '@/lib/types';

export interface StationFeed {
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  dj: DjState | null;
  activeShow: ActiveShow | null;
  listeners: ListenerCount | number | null;
  streamOnline: boolean | null;
  stream: PublicStreamInfo | null;
  /** Cumulative since-boot LLM token total, or null before the first poll. */
  llmTokens: number | null;
  state: StationState;
  session: SessionPayload;
  elapsed: number;
  progress: number;
  /** Station IANA timezone, or null before first poll. Render on-air
   *  timestamps in this zone so they match what the DJ speaks (issue #418). */
  timezone: string | null;
  locale: StationLocale;
}

const EMPTY_STATE: StationState = { upcoming: [], history: [], djLog: [] };
const EMPTY_SESSION: SessionPayload = { session: null, messages: [] };
// A single "offline" poll can be a transient controller blip; flipping to
// offline on it would tear playback down mid-song (PlayerScreen stops on
// offline). Require this many consecutive offline polls before believing it —
// same debounce as the web player (#463/#466). At the foreground 5s cadence
// that's ~20s; on the 30s background poll it's slower, which errs toward
// keeping the music playing.
const OFFLINE_CONFIRM_POLLS = 4;

export function useStationFeed(
  api: StationApi | null,
  opts?: { backgroundPoll?: boolean | RefObject<boolean> },
): StationFeed {
  const backgroundPoll = opts?.backgroundPoll ?? false;
  const [nowPlaying, setNowPlaying] = useState<NowPlayingTrack | null>(null);
  const [context, setContext] = useState<StationContext | null>(null);
  const [dj, setDj] = useState<DjState | null>(null);
  const [activeShow, setActiveShow] = useState<ActiveShow | null>(null);
  const [listeners, setListeners] = useState<ListenerCount | number | null>(null);
  const [streamOnline, setStreamOnline] = useState<boolean | null>(null);
  const [stream, setStream] = useState<PublicStreamInfo | null>(null);
  const [llmTokens, setLlmTokens] = useState<number | null>(null);
  const [state, setState] = useState<StationState>(EMPTY_STATE);
  const [session, setSession] = useState<SessionPayload>(EMPTY_SESSION);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [locale, setLocale] = useState<StationLocale>(DEFAULT_STATION_LOCALE);
  const [elapsed, setElapsed] = useState(0);
  const trackStartRef = useRef<number | null>(null);
  const offlinePollsRef = useRef(0);
  const appActive = useAppActive();

  // Per-field payload signatures: skip the setState (keeping the previous
  // object identity) when a poll returns byte-identical data.
  const sigRef = useRef<Record<string, string>>({});
  const setIfChanged = useCallback(<T,>(key: string, value: T, set: (v: T) => void) => {
    const sig = JSON.stringify(value) ?? 'null';
    if (sigRef.current[key] === sig) return;
    sigRef.current[key] = sig;
    set(value);
  }, []);

  // On station switch, drop the previous station's data immediately — without
  // this the new station briefly shows the old one's track/cover/booth, and
  // stale payload signatures could suppress the first updates. Declared before
  // the poll effect so the reset lands before the new station's first tick.
  const prevApiRef = useRef(api);
  useEffect(() => {
    if (prevApiRef.current === api) return;
    prevApiRef.current = api;
    sigRef.current = {};
    trackStartRef.current = null;
    offlinePollsRef.current = 0;
    setNowPlaying(null);
    setContext(null);
    setDj(null);
    setActiveShow(null);
    setListeners(null);
    setStreamOnline(null);
    setStream(null);
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
    const shouldPollInBackground =
      typeof backgroundPoll === 'boolean' ? backgroundPoll : backgroundPoll.current;
    if (background && !shouldPollInBackground) return;
    let cancelled = false;

    const applyNowPlaying = (npRes: NowPlayingResponse) => {
      setIfChanged('nowPlaying', npRes.nowPlaying, () =>
        setNowPlaying((prev) => {
          if (
            npRes.nowPlaying?.title !== prev?.title ||
            npRes.nowPlaying?.artist !== prev?.artist
          ) {
            trackStartRef.current = Date.now();
          }
          return npRes.nowPlaying;
        }),
      );
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
      setIfChanged('stream', npRes.stream ?? null, setStream);
      if (typeof npRes.llmTokens === 'number') setIfChanged('llmTokens', npRes.llmTokens, setLlmTokens);
      if (typeof npRes.timezone === 'string' && npRes.timezone) setTimezone(npRes.timezone);
      if (npRes.locale === 'en-US' || npRes.locale === 'en-GB') setLocale(npRes.locale);
    };

    const tick = async () => {
      if (background) {
        // Lock-screen metadata only — no point feeding UI nobody can see.
        try {
          const npRes = await api.nowPlaying();
          if (!cancelled) applyNowPlaying(npRes);
        } catch {
          /* transient — next tick retries */
        }
        return;
      }
      // allSettled: one slow/failed endpoint shouldn't stall the others;
      // failures are transient — the next tick retries.
      const [np, st, se] = await Promise.allSettled([
        api.nowPlaying(),
        api.state(),
        api.session(),
      ]);
      if (cancelled) return;
      if (np.status === 'fulfilled') applyNowPlaying(np.value);
      if (st.status === 'fulfilled') setIfChanged('state', st.value, setState);
      if (se.status === 'fulfilled' && se.value && Array.isArray(se.value.messages)) {
        setIfChanged('session', se.value, setSession);
      }
    };
    tick();
    const id = setInterval(tick, background ? 30000 : 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api, appActive, backgroundPoll, setIfChanged]);

  useEffect(() => {
    if (!appActive) return;
    const update = () => {
      if (trackStartRef.current) {
        setElapsed(Math.floor((Date.now() - trackStartRef.current) / 1000));
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
    stream,
    llmTokens,
    state,
    session,
    elapsed,
    progress,
    timezone,
    locale,
  };
}
