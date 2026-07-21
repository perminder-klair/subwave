'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import { useStationClient } from '@/lib/stationClient';
import type {
  ActiveShow,
  DjState,
  ListenerCount,
  NowPlayingTrack,
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
  /** Cumulative since-boot LLM token total, or null before the first poll. */
  llmTokens: number | null;
  state: StationState;
  session: SessionPayload;
  /** Epoch ms when the current track became AUDIBLE to this listener, null
   *  before the first poll. Consumers derive elapsed/progress from it locally
   *  (useElapsed) so the per-second tick doesn't re-render the whole player
   *  tree.
   *
   *  Listener-time, not broadcast-time: the server stamps startedAt at the live
   *  edge, but Icecast bursts `stream.bufferSeconds` of audio on connect so
   *  everyone hears that far behind it. This carries the offset already added,
   *  which is why it can briefly sit in the future — useElapsed clamps at 0, so
   *  the clock holds 0:00 until the track actually starts instead of banking
   *  the buffer as elapsed time (issue #1113). */
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
  const client = useStationClient();
  const [nowPlaying, setNowPlaying] = useState<NowPlayingTrack | null>(null);
  const [context, setContext] = useState<StationContext | null>(null);
  const [dj, setDj] = useState<DjState | null>(null);
  const [activeShow, setActiveShow] = useState<ActiveShow | null>(null);
  const [listeners, setListeners] = useState<ListenerCount | number | null>(null);
  const [streamOnline, setStreamOnline] = useState<boolean | null>(null);
  const [llmTokens, setLlmTokens] = useState<number | null>(null);
  const [state, setState] = useState<StationState>(EMPTY_STATE);
  const [session, setSession] = useState<SessionPayload>(EMPTY_SESSION);
  const [trackStartedAt, setTrackStartedAt] = useState<number | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [locale, setLocale] = useState<StationLocale>('en-GB');
  const lastTrackKeyRef = useRef<string | null>(null);
  const offlinePollsRef = useRef(0);
  // Listener buffer depth, in ms. Lives in a ref (not state) so the polling
  // effect never re-subscribes when it arrives — it only needs the latest value
  // at tick time. 0 until the first payload lands, which degrades to the old
  // live-edge behaviour rather than guessing an offset.
  const leadMsRef = useRef(0);
  // Pending track switch: a track whose metadata has arrived but whose audio
  // hasn't reached this listener yet. Held here until it's audible.
  const promoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const [npRes, stRes, seRes] = await Promise.all([
          client.nowPlaying(),
          client.state(),
          client.session(),
        ]);
        const np = npRes.nowPlaying;
        // Refresh the buffer depth before it's used below. Clamped to a sane
        // window: a bad value here would either park the clock in the far
        // future or wind it back past the track start.
        const bufSec = npRes.stream?.bufferSeconds;
        if (typeof bufSec === 'number' && Number.isFinite(bufSec)) {
          leadMsRef.current = Math.min(Math.max(bufSec, 0), 60) * 1000;
        }
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
        // Shift into listener-time. serverStart is the live edge; the audio
        // reaches this listener leadMs later, so that's when the track is
        // genuinely "now playing" for them (issue #1113).
        const leadMs = leadMsRef.current;
        const audibleAt = Number.isFinite(serverStart) ? serverStart + leadMs : Date.now();

        if (trackKey !== lastTrackKeyRef.current) {
          const commit = () => {
            promoteTimerRef.current = null;
            lastTrackKeyRef.current = trackKey;
            setTrackStartedAt(trackKey != null ? audibleAt : null);
            setIfChanged(setNowPlaying, np);
          };
          const wait = audibleAt - Date.now();
          // Promote immediately when the audio is already out (wait <= 0), when
          // the stream drops (nothing to stay in sync with), or on the very
          // first payload — a cold load has no earlier track to keep showing,
          // so showing the incoming one is the best available answer. The clock
          // is still right in that case because trackStartedAt carries the
          // offset and useElapsed clamps at 0.
          if (wait <= 0 || trackKey == null || lastTrackKeyRef.current == null) {
            if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
            commit();
          } else {
            // Re-armed on every poll while the switch is pending, so the wait
            // is always recomputed against the freshest server stamp rather
            // than drifting on a stale one.
            if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
            promoteTimerRef.current = setTimeout(commit, wait);
          }
        } else {
          if (Number.isFinite(serverStart)) {
            // Same track, better information — converge on the server stamp (and
            // repair any mid-track reset) without re-render noise inside ±2.5s.
            setTrackStartedAt(prev =>
              prev != null && Math.abs(audibleAt - prev) <= 2500 ? prev : audibleAt,
            );
          }
          // Metadata enrichment (genres, bpm, cover) lands on later polls for a
          // track already on air — keep taking it.
          setIfChanged(setNowPlaying, np);
        }
        setIfChanged(setContext, npRes.context);
        if (npRes.dj) setIfChanged<DjState | null>(setDj, npRes.dj);
        setIfChanged(setActiveShow, npRes.activeShow ?? npRes.context?.activeShow ?? null);
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
    const stopPolling = pollWhileVisible(() => { void tick(); }, 5000);
    return () => {
      stopPolling();
      // A held track switch must not land after teardown.
      if (promoteTimerRef.current) {
        clearTimeout(promoteTimerRef.current);
        promoteTimerRef.current = null;
      }
    };
  }, [client]);

  return { nowPlaying, context, dj, activeShow, listeners, streamOnline, llmTokens, state, session, trackStartedAt, timezone, locale };
}
