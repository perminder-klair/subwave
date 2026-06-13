'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { CalendarClock, History, Mic } from 'lucide-react';
import TopBar from './TopBar';
import CenterStage from './CenterStage';
import Waveform from './Waveform';
import TransportBar from './TransportBar';
import TuneInOverlay from './TuneInOverlay';
import DotRail from './DotRail';
import CommandPalette, { type PlayerDrawer } from './CommandPalette';
import ShortcutsDialog from './ShortcutsDialog';
import { Sheet } from './ui/sheet';
import { Toaster } from './ui/toaster';
import TimelineDrawer from './drawers/TimelineDrawer';
import BoothDrawer from './drawers/BoothDrawer';
import RequestDrawer from './drawers/RequestDrawer';
import ScheduleDrawer from './drawers/ScheduleDrawer';
import { useStationFeed } from '@/hooks/useStationFeed';
import { usePlayer } from '@/hooks/usePlayer';
import { useSignal } from '@/hooks/useSignal';
import { useMediaSession } from '@/hooks/useMediaSession';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useCoverColors } from '@/hooks/useCoverColors';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { cn } from '@/lib/cn';
import { useStationOrigin } from '@/lib/stationOrigin';
import type { RequestResult } from '@/lib/types';

const DRAWER_TITLES: Record<PlayerDrawer, string> = {
  timeline: 'Timeline',
  booth: 'Booth feed',
  request: 'Make a request',
  schedule: 'Schedule',
};

// Hoisted so the DotRail counts memo below keeps stable element references —
// recreating these per render would defeat DotRail's React.memo.
const TIMELINE_ICON = <History size={18} strokeWidth={1.5} />;
const BOOTH_ICON = <Mic size={18} strokeWidth={1.5} />;
const SCHEDULE_ICON = <CalendarClock size={18} strokeWidth={1.5} />;

export interface PlayerAppProps {
  contained?: boolean;
}

export default function PlayerApp({ contained = false }: PlayerAppProps) {
  const { apiUrl } = useStationOrigin();
  const { nowPlaying, context, dj, activeShow, listeners, streamOnline, state, session, trackStartedAt } = useStationFeed();
  const boothFeed = session.messages;
  const { audioRef, tunedIn, status, volume, setVolume, tune, stop, toggleMute, muted, idleStopped } = usePlayer();

  // streamOnline is null until the first poll resolves — only treat an
  // explicit false as offline so the player never flashes "offline" on load.
  const offline = streamOnline === false;

  // Connection-health meter for the footer's signal scale — measured latency
  // to the controller, probed only while tuned in (see useSignal).
  const signal = useSignal({ tunedIn, status, offline });

  // Listener count now lives in the footer's signal readout (not the header) —
  // normalise the feed's number | { current } | null shape to a plain count.
  const listenerCount =
    listeners == null ? null : typeof listeners === 'number' ? listeners : (listeners.current ?? null);

  // If the station goes off air while someone is tuned in, tear playback down
  // so the <audio> element isn't left retrying a dead mount.
  useEffect(() => {
    if (offline && tunedIn) stop();
  }, [offline, tunedIn, stop]);

  // Persona avatar to surface on the OS lock screen while the DJ is talking.
  // Prefer the on-air show's persona (a scheduled show can hand the hour to a
  // different DJ); fall back to the global "active" persona from /now-playing.
  // The controller emits a path without the `/api` prefix; prepend the
  // station's API base so this resolves the same way in prod (via Caddy),
  // dev (direct origin), and the landing showcase (remote station).
  const avatarPath =
    (typeof activeShow?.persona?.avatar === 'string' && activeShow.persona.avatar) ||
    (typeof dj?.avatar === 'string' ? dj.avatar : '') ||
    '';
  const personaAvatarUrl = avatarPath ? `${apiUrl}${avatarPath}` : null;
  const personaName =
    (typeof activeShow?.persona?.name === 'string' && activeShow.persona.name) ||
    (typeof dj?.name === 'string' ? dj.name : '') ||
    null;

  // Wire OS-level media controls (lock screen, headphones, car display).
  // No onSkip on the public listener — a stray AirPods double-tap shouldn't
  // skip the song for every other listener on the station.
  useMediaSession({
    tunedIn,
    nowPlaying,
    audioRef,
    onTune: tune,
    boothFeed,
    personaAvatarUrl,
    personaName,
  });

  const rootRef = useRef<HTMLDivElement | null>(null);
  // Drawers/dialogs portal here when contained so they stay inside the frame.
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  useEffect(() => { if (contained) setPortalNode(rootRef.current); }, [contained]);

  // Art-derived ambient wash — extract a couple of colours from the current
  // cover and feed them to the gradient layer behind the player. Same coverSrc
  // shape as CenterStage so the extraction hits the controller's cached proxy.
  const coverSubsonicId = nowPlaying?.subsonic_id ?? null;
  const coverSrc = coverSubsonicId
    ? `${apiUrl}/cover/${encodeURIComponent(coverSubsonicId)}`
    : null;
  const coverColors = useCoverColors(coverSrc);
  const ambientRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(ambientRef, {
    '--cover-tint': coverColors.vibrant,
    '--cover-tint-2': coverColors.average ?? coverColors.vibrant,
  });

  const [requestText, setRequestText] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [drawer, setDrawer] = useState<PlayerDrawer | null>(null);

  // Stable handlers + counts for the memoized layout components, so a feed
  // update that doesn't touch them costs no re-render.
  const openSchedule = useCallback(() => setDrawer('schedule'), []);
  const openBooth = useCallback(() => setDrawer('booth'), []);
  const openTimeline = useCallback(() => setDrawer('timeline'), []);
  const upcomingCount = state.upcoming?.length ?? 0;
  const dotRailCounts = useMemo(
    () => ({
      timeline: upcomingCount || TIMELINE_ICON,
      booth: BOOTH_ICON,
      schedule: SCHEDULE_ICON,
    }),
    [upcomingCount],
  );
  const [tickerOn, setTickerOn] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Mirror the tune-button feel from TransportBar: a short pulse on open,
  // a lighter one on close, so every entry point (DotRail, shortcut, palette,
  // swipe-dismiss) gets the same tactile confirmation.
  const prevDrawerRef = useRef<PlayerDrawer | null>(drawer);
  useEffect(() => {
    const prev = prevDrawerRef.current;
    prevDrawerRef.current = drawer;
    if (prev === drawer) return;
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    if (prev == null && drawer != null) navigator.vibrate(8);
    else if (prev != null && drawer == null) navigator.vibrate(5);
    else navigator.vibrate(6);
  }, [drawer]);

  // First-paint tune-in gate. Shown on every fresh load until the listener
  // taps it; dismissed permanently for the rest of the session once they've
  // tuned in, so a later Tune Out doesn't bring the overlay back.
  const [showTuneIn, setShowTuneIn] = useState(true);
  const tuneInFromOverlay = () => {
    setShowTuneIn(false);
    tune();
  };

  // Idle cutoff fired (usePlayer tuned the abandoned tab out, issue #343):
  // bring the tune-in gate back as the one-tap resume and say why playback
  // stopped. Lock-screen Play also resumes, via useMediaSession's onTune.
  useEffect(() => {
    if (!idleStopped) return;
    setShowTuneIn(true);
    toast('Tuned out while you were away — tap to keep listening.');
  }, [idleStopped]);

  // Whenever playback is actually running, the gate has done its job — drop
  // it. Covers resume paths that bypass the overlay tap (lock-screen Play
  // after an idle cutoff goes straight through tune()).
  useEffect(() => {
    if (tunedIn) setShowTuneIn(false);
  }, [tunedIn]);

  // Hydrate ticker preference from localStorage (avoids SSR hydration mismatch).
  useEffect(() => {
    try {
      const v = localStorage.getItem('subwave:ticker');
      if (v != null) setTickerOn(v === '1');
    } catch {}
  }, []);

  // Tune toggle for shortcuts/palette — also dismisses the first-paint gate,
  // so Space behaves like tapping the overlay before the listener has tuned in.
  const handleTune = () => {
    if (showTuneIn) tuneInFromOverlay();
    else tune();
  };
  // Ticker that increments only on keyboard-driven volume adjusts. The
  // TransportBar watches it to pulse the volume cells; slider drags don't
  // tick it (the cells need to track the finger pixel-for-pixel during a
  // drag — pulsing would fight that).
  const [volumePulse, setVolumePulse] = useState(0);
  const adjustVolume = (delta: number) => {
    setVolume(v => Math.min(1, Math.max(0, Math.round((v + delta) * 100) / 100)));
    setVolumePulse(n => n + 1);
  };

  // Global keyboard shortcuts. Bare keys are suppressed while a text field
  // is focused or while the palette/help dialog owns input; ⌘K always works.
  useKeyboardShortcuts(
    {
      space: handleTune,
      k: handleTune,
      arrowup: () => adjustVolume(0.05),
      arrowdown: () => adjustVolume(-0.05),
      m: toggleMute,
      '1': () => setDrawer('timeline'),
      '2': () => setDrawer('booth'),
      '3': () => setDrawer('request'),
      '4': () => setDrawer('schedule'),
      r: () => setDrawer('request'),
      '?': () => setShortcutsOpen(true),
      'mod+k': () => setPaletteOpen(o => !o),
    },
    { disabled: paletteOpen || shortcutsOpen },
  );

  // Submit a request. The controller accepts in ~50ms and returns a request
  // id; the actual matching runs in the booth. The drawer then polls
  // pollRequest() for the outcome.
  const submitRequest = async (): Promise<RequestResult | null> => {
    if (!requestText.trim() || isSubmitting) return null;
    setIsSubmitting(true);
    try {
      const res = await fetch(`${apiUrl}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: requestText.trim(), name: requesterName.trim() }),
      });
      const data = (await res.json()) as RequestResult;
      if (data.success) setRequestText('');
      return data;
    } catch {
      toast.error('Request failed. Is the controller up?');
      return { success: false, message: 'Network error.' };
    } finally {
      setIsSubmitting(false);
    }
  };

  // Poll a submitted request for its outcome. Returns the controller's
  // status payload, or null on a network error so the drawer keeps trying.
  const pollRequest = async (requestId: string): Promise<RequestResult | null> => {
    try {
      const res = await fetch(`${apiUrl}/request/${requestId}`);
      if (res.status === 404) return { success: false, status: 'unknown' };
      return (await res.json()) as RequestResult;
    } catch {
      return null;
    }
  };

  return (
    <div
      ref={rootRef}
      className={cn(contained ? 'absolute' : 'fixed', 'inset-0 overflow-hidden bg-bg text-ink')}
    >
      <div
        ref={ambientRef}
        aria-hidden="true"
        className={cn('v3-cover-ambient', coverColors.vibrant && 'v3-cover-ambient-on')}
      />

      <audio ref={audioRef} crossOrigin="anonymous" preload="auto" />

      <TopBar
        tunedIn={tunedIn}
        context={context}
        stationName={typeof dj?.station === 'string' ? dj.station : undefined}
        djName={typeof dj?.name === 'string' ? dj.name : undefined}
        activeShow={activeShow}
        onOpenSchedule={openSchedule}
      />

      <CenterStage
        nowPlaying={nowPlaying}
        trackStartedAt={trackStartedAt}
        feed={boothFeed}
        djLineOn={tickerOn}
        onOpenBooth={openBooth}
        onOpenTimeline={openTimeline}
      />

      <Waveform
        audioRef={audioRef}
        tunedIn={tunedIn}
        trackStartedAt={trackStartedAt}
        duration={nowPlaying?.duration ?? 0}
      />

      <DotRail counts={dotRailCounts} active={drawer} onSelect={setDrawer} />

      <TransportBar
        tunedIn={tunedIn}
        status={status}
        onTune={tune}
        offline={offline}
        volume={volume}
        setVolume={setVolume}
        volumePulse={volumePulse}
        muted={muted}
        onToggleMute={toggleMute}
        latencyMs={signal.latencyMs}
        signalQuality={signal.quality}
        listeners={listenerCount}
        nowPlaying={nowPlaying}
        trackStartedAt={trackStartedAt}
      />

      <Sheet
        open={drawer != null}
        onOpenChange={(v: boolean) => { if (!v) setDrawer(null); }}
        title={drawer ? DRAWER_TITLES[drawer] : ''}
        container={portalNode}
      >
        {drawer === 'timeline' && (
          <TimelineDrawer upcoming={state.upcoming} history={state.history} />
        )}
        {drawer === 'booth'   && <BoothDrawer items={boothFeed} />}
        {drawer === 'request' && (
          <RequestDrawer
            requestText={requestText} setRequestText={setRequestText}
            requesterName={requesterName} setRequesterName={setRequesterName}
            isSubmitting={isSubmitting}
            onSubmit={submitRequest}
            onPoll={pollRequest}
            onClose={() => setDrawer(null)}
            nowPlaying={nowPlaying}
            context={context}
          />
        )}
        {drawer === 'schedule' && <ScheduleDrawer activeShow={activeShow} context={context} />}
      </Sheet>

      <AnimatePresence>
        {showTuneIn && !offline && (
          <TuneInOverlay key="tune-in" onTune={tuneInFromOverlay} nowPlaying={nowPlaying} />
        )}
      </AnimatePresence>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        container={portalNode}
        tunedIn={tunedIn}
        muted={muted}
        onTune={handleTune}
        onOpenDrawer={setDrawer}
        onToggleMute={toggleMute}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />

      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        container={portalNode}
      />

      {!contained && <Toaster />}
    </div>
  );
}
