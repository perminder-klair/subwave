'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import { useStationOrigin } from '@/lib/stationOrigin';
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
  StationLocale,
} from '@/lib/types';

export interface StationFeed {
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  dj: DjState | null;
  activeShow: ActiveShow | null;
  listeners: ListenerCount | number | null;
  /** null until the first poll resolves — distinguishes "not yet known" from "offline". */
  streamOnline: boolean | null;
  stream: PublicStreamInfo | null;
  /** Cumulative since-boot LLM token total, or null before the first poll. */
  llmTokens: number | null;
  state: StationState;
  session: SessionPayload;
  /** Epoch ms when the current track was first seen, null before the first
   *  poll. Consumers derive elapsed/progress from it locally (useElapsed) so
   *  the per-second tick doesn't re-render the whole player tree. */
  trackStartedAt: number | null;
  /** Station IANA timezone (e.g. "Europe/London"), or null before first poll.
   *  Render on-air timestamps in this zone so they match what the DJ speaks
   *  (issue #418). */
  timezone: string | null;
  locale: StationLocale;
}

const EMPTY_STATE: StationState = { upcoming: [], history: [], djLog: [] };
const EMPTY_SESSION: SessionPayload = { session: null, messages: [] };
const OFFLINE_CONFIRM_POLLS = 4;

// Only commit a freshly-parsed payload when it differs from what's already in
// state — returning `prev` from the updater skips the re-render, so a quiet
// poll tick costs nothing. Server JSON keeps stable key order, making the
// stringify comparison reliable (and cheap at a few KB every 5s).
function setIfChanged<T>(setter: Dispatch<SetStateAction<T>>, next: T): void {
  setter(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
}

// 5s polling of /now-playing + /state + /session, paused while the tab is
// hidden (with an immediate refetch on return). Single source of truth for
// "what's on air right now".
export function useStationFeed(): StationFeed {
  const { apiUrl } = useStationOrigin();
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
  const [trackStartedAt, setTrackStartedAt] = useState<number | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [locale, setLocale] = useState<StationLocale>('en-GB');
  const lastTrackKeyRef = useRef<string | null>(null);
  const offlinePollsRef = useRef(0);

  useEffect(() => {
    const tick = async () => {
      try {
        const [npRes, stRes, seRes] = (await Promise.all([
          fetch(`${apiUrl}/now-playing`).then(r => r.json()),
          fetch(`${apiUrl}/state`).then(r => r.json()),
          fetch(`${apiUrl}/session`).then(r => r.json()),
        ])) as [NowPlayingResponse, StationState, SessionPayload];
        const np = npRes.nowPlaying;
        const trackKey = np ? `${np.title}\u0000${np.artist}` : null;
        // Prefer the queue's authoritative start time over "first seen by this
        // client": a tab that was hidden at the transition (or a poll that hit
        // a torn now-playing.json read and flipped through null) would stamp
        // Date.now() mid-track, dragging elapsed/remaining/progress minutes
        // behind the broadcast. Guarded to the matching track and to plausible
        // values (a skewed server clock in the future falls back to first-seen).
        const cur = (stRes as StationState & { current?: { title?: string; startedAt?: string } }).current;
        let serverStart = NaN;
        if (np?.title && cur && cur.title === np.title && cur.startedAt) {
          const t = Date.parse(cur.startedAt);
          if (Number.isFinite(t) && t <= Date.now()) serverStart = t;
        }
        if (trackKey !== lastTrackKeyRef.current) {
          lastTrackKeyRef.current = trackKey;
          setTrackStartedAt(trackKey != null ? (Number.isFinite(serverStart) ? serverStart : Date.now()) : null);
        } else if (Number.isFinite(serverStart)) {
          // Same track, better information — converge on the server stamp (and
          // repair any mid-track reset) without re-render noise inside ±2.5s.
          setTrackStartedAt(prev =>
            prev != null && Math.abs(serverStart - prev) <= 2500 ? prev : serverStart,
          );
        }
        setIfChanged(setNowPlaying, np);
        setIfChanged(setContext, npRes.context);
        if (npRes.dj) setIfChanged<DjState | null>(setDj, npRes.dj);
        setIfChanged(setActiveShow, npRes.activeShow ?? npRes.context?.activeShow ?? null);
        setIfChanged(setStream, npRes.stream ?? null);
        if (npRes.listeners != null) setIfChanged<ListenerCount | number | null>(setListeners, npRes.listeners);
        if (typeof npRes.streamOnline === 'boolean') {
          if (npRes.streamOnline) {
            offlinePollsRef.current = 0;
            setStreamOnline(true);
          } else {
            offlinePollsRef.current += 1;
            if (offlinePollsRef.current >= OFFLINE_CONFIRM_POLLS) setStreamOnline(false);
          }
        }
        if (typeof npRes.llmTokens === 'number') setIfChanged<number | null>(setLlmTokens, npRes.llmTokens);
        if (typeof npRes.timezone === 'string' && npRes.timezone) setTimezone(npRes.timezone);
        if (npRes.locale === 'en-US' || npRes.locale === 'en-GB') setLocale(npRes.locale);
        setIfChanged(setState, stRes);
        if (seRes && Array.isArray(seRes.messages)) setIfChanged(setSession, seRes);
      } catch {}
    };
    return pollWhileVisible(() => { void tick(); }, 5000);
  }, [apiUrl]);

  return { nowPlaying, context, dj, activeShow, listeners, streamOnline, stream, llmTokens, state, session, trackStartedAt, timezone, locale };
}
