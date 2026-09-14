'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import { splitAudibleTurns } from '@/lib/sessionFeed';
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
   *  before the first poll. Listener-time, not live-edge: it carries the
   *  `stream.bufferSeconds` offset already added and can briefly sit in the
   *  future, so useElapsed clamps at 0 (issue #1114). */
  trackStartedAt: number | null;
  /** Whether the station is configured to serve `/stream.opus`, null before the
   *  first poll. The SETTING, not a live mount probe: it needs a mixer restart,
   *  so it can read true while the mount still 404s (issue #1300). */
  opusEnabled: boolean | null;
  /** Station IANA timezone, or null before the first poll. Render on-air
   *  timestamps in this zone so they match what the DJ speaks (issue #418). */
  timezone: string | null;
  locale: StationLocale;
}

const EMPTY_STATE: StationState = { upcoming: [], history: [], djLog: [] };
const EMPTY_SESSION: SessionPayload = { session: null, messages: [] };
const OFFLINE_CONFIRM_POLLS = 4;

// Returning `prev` skips the re-render, so a quiet poll tick costs nothing.
// Server JSON keeps stable key order, so the stringify compare is reliable.
function setIfChanged<T>(setter: Dispatch<SetStateAction<T>>, next: T): void {
  setter(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
}

// 5s polling of /now-playing + /state + /session, paused while the tab is
// hidden (with an immediate refetch on return).
//
// The listener offset is the advertised stream.bufferSeconds. Never measure it
// as `buffered.end − currentTime`: that reports only the demuxed window (2.25s
// against a true 22.5s offset), which flips every title ~20s early.
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
  const [opusEnabled, setOpusEnabled] = useState<boolean | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [locale, setLocale] = useState<StationLocale>('en-GB');
  const lastTrackKeyRef = useRef<string | null>(null);
  const offlinePollsRef = useRef(0);
  // Listener buffer depth in ms. A ref, not state, so the polling effect never
  // re-subscribes when it arrives. 0 until the first payload lands, degrading
  // to live-edge behaviour rather than guessing an offset.
  const leadMsRef = useRef(0);
  // Holds a track whose metadata has arrived but whose audio hasn't reached
  // this listener yet, until it's audible.
  const promoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Same for the DJ's spoken lines (#1382), stamped with the live-edge air
  // time. Raw payload in a ref, filtered copy in state.
  const rawSessionRef = useRef<SessionPayload>(EMPTY_SESSION);
  const voiceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Re-derive the visible feed and re-arm for the next line to become
    // audible. Runs on every poll and on its own timer, so a held line lands on
    // time rather than on the 5s poll grid.
    const applySession = () => {
      const raw = rawSessionRef.current;
      const { visible, nextChangeMs } = splitAudibleTurns(raw.messages, leadMsRef.current, Date.now());
      setIfChanged(setSession, { session: raw.session, messages: visible });
      if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
      voiceTimerRef.current = nextChangeMs == null
        ? null
        : setTimeout(applySession, Math.max(0, nextChangeMs - Date.now()));
    };
    const tick = async () => {
      try {
        const [npRes, stRes, seRes] = await Promise.all([
          client.nowPlaying(),
          client.state(),
          client.session(),
        ]);
        const np = npRes.nowPlaying;
        // Clamped to 0–60s: a bad value parks the clock in the far future or
        // winds it back past the track start.
        const bufSec = npRes.stream?.bufferSeconds;
        if (typeof bufSec === 'number' && Number.isFinite(bufSec)) {
          leadMsRef.current = Math.min(Math.max(bufSec, 0), 60) * 1000;
        }
        const trackKey = np ? `${np.title}\u0000${np.artist}` : null;
        // Prefer the queue's start time over "first seen by this client": a tab
        // hidden at the transition would stamp Date.now() mid-track. Guarded to
        // the matching track and to plausible values; a server clock skewed into
        // the future falls back to first-seen.
        const cur = (stRes as StationState & { current?: { title?: string; startedAt?: string } }).current;
        let serverStart = NaN;
        if (np?.title && cur && cur.title === np.title && cur.startedAt) {
          const t = Date.parse(cur.startedAt);
          if (Number.isFinite(t) && t <= Date.now()) serverStart = t;
        }
        // Shift into listener-time: serverStart is the live edge, and the audio
        // reaches this listener leadMs later (issue #1114).
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
          // the stream drops, or on the first payload (a cold load has no
          // earlier track to keep showing).
          if (wait <= 0 || trackKey == null || lastTrackKeyRef.current == null) {
            if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
            commit();
          } else {
            // Re-armed on every poll while the switch is pending, so the wait
            // is recomputed against the freshest server stamp.
            if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
            promoteTimerRef.current = setTimeout(commit, wait);
          }
        } else {
          if (Number.isFinite(serverStart)) {
            // Same track: converge on the server stamp without re-render noise
            // inside ±2.5s.
            setTrackStartedAt(prev =>
              prev != null && Math.abs(audibleAt - prev) <= 2500 ? prev : audibleAt,
            );
          }
          // Metadata enrichment (genres, bpm, cover) lands on later polls for a
          // track already on air, so keep taking it.
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
        // Only an explicit boolean counts: an older controller omits the key,
        // and "unknown" must not read as "on".
        if (typeof npRes.stream?.opusEnabled === 'boolean') {
          setIfChanged<boolean | null>(setOpusEnabled, npRes.stream.opusEnabled);
        }
        if (typeof npRes.llmTokens === 'number') setIfChanged<number | null>(setLlmTokens, npRes.llmTokens);
        if (typeof npRes.timezone === 'string' && npRes.timezone) setTimezone(npRes.timezone);
        if (npRes.locale === 'en-US' || npRes.locale === 'en-GB') setLocale(npRes.locale);
        setIfChanged(setState, stRes);
        if (seRes && Array.isArray(seRes.messages)) {
          rawSessionRef.current = seRes;
          applySession();
        }
      } catch {}
    };
    const stopPolling = pollWhileVisible(() => { void tick(); }, 5000);
    return () => {
      stopPolling();
      // A held track switch (or a held spoken line) must not land after teardown.
      if (promoteTimerRef.current) {
        clearTimeout(promoteTimerRef.current);
        promoteTimerRef.current = null;
      }
      if (voiceTimerRef.current) {
        clearTimeout(voiceTimerRef.current);
        voiceTimerRef.current = null;
      }
    };
  }, [client]);

  return { nowPlaying, context, dj, activeShow, listeners, streamOnline, llmTokens, state, session, trackStartedAt, opusEnabled, timezone, locale };
}
