// Native port of web/web/hooks/useStationFeed.ts.
//
// 5s polling of /now-playing + /state + /session, plus a 1s elapsed tick that
// resets on track-change. The base URL comes from the StationApi passed in
// (runtime), not a build-time env. Logic is otherwise unchanged.

import { useEffect, useRef, useState } from 'react';
import type { StationApi } from '@/lib/api';
import type {
  ActiveShow,
  DjState,
  ListenerCount,
  NowPlayingTrack,
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
  state: StationState;
  session: SessionPayload;
  elapsed: number;
  progress: number;
}

const EMPTY_STATE: StationState = { upcoming: [], history: [], djLog: [] };
const EMPTY_SESSION: SessionPayload = { session: null, messages: [] };

export function useStationFeed(api: StationApi | null): StationFeed {
  const [nowPlaying, setNowPlaying] = useState<NowPlayingTrack | null>(null);
  const [context, setContext] = useState<StationContext | null>(null);
  const [dj, setDj] = useState<DjState | null>(null);
  const [activeShow, setActiveShow] = useState<ActiveShow | null>(null);
  const [listeners, setListeners] = useState<ListenerCount | number | null>(null);
  const [streamOnline, setStreamOnline] = useState<boolean | null>(null);
  const [state, setState] = useState<StationState>(EMPTY_STATE);
  const [session, setSession] = useState<SessionPayload>(EMPTY_SESSION);
  const [elapsed, setElapsed] = useState(0);
  const trackStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [npRes, stRes, seRes] = await Promise.all([
          api.nowPlaying(),
          api.state(),
          api.session(),
        ]);
        if (cancelled) return;
        setNowPlaying((prev) => {
          if (
            npRes.nowPlaying?.title !== prev?.title ||
            npRes.nowPlaying?.artist !== prev?.artist
          ) {
            trackStartRef.current = Date.now();
          }
          return npRes.nowPlaying;
        });
        setContext(npRes.context);
        if (npRes.dj) setDj(npRes.dj);
        setActiveShow(npRes.activeShow ?? npRes.context?.activeShow ?? null);
        if (npRes.listeners != null) setListeners(npRes.listeners);
        if (typeof npRes.streamOnline === 'boolean') setStreamOnline(npRes.streamOnline);
        setState(stRes);
        if (seRes && Array.isArray(seRes.messages)) setSession(seRes);
      } catch {
        /* transient — next tick retries */
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api]);

  useEffect(() => {
    const id = setInterval(() => {
      if (trackStartRef.current) {
        setElapsed(Math.floor((Date.now() - trackStartRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const duration = nowPlaying?.duration ?? 0;
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

  return {
    nowPlaying,
    context,
    dj,
    activeShow,
    listeners,
    streamOnline,
    state,
    session,
    elapsed,
    progress,
  };
}
