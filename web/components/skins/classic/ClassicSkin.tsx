'use client';

// The original SUB/WAVE player face — masthead, centre stage, waveform,
// transport deck, dot-rail drawers, ⌘K palette. The first consumer of the
// skin contract (see ../types.ts): everything here reads the core contexts;
// the shell owns the <audio> element, the root frame, and the toaster.

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
import TimelineDrawer from './drawers/TimelineDrawer';
import BoothDrawer from './drawers/BoothDrawer';
import RequestDrawer from './drawers/RequestDrawer';
import ScheduleDrawer from './drawers/ScheduleDrawer';
import { Sheet } from '@/components/ui/sheet';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useCoverColors } from '@/hooks/useCoverColors';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { cn } from '@/lib/cn';
import { useStationClient } from '@/lib/stationClient';
import type { SkinProps } from '@/components/skins/types';
import type { QueueEntry, RequestResult } from '@/lib/types';

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

export default function ClassicSkin({ portalNode }: SkinProps) {
  const client = useStationClient();
  const {
    nowPlaying, context, dj, activeShow, listeners, llmTokens,
    state, session, trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const boothFeed = session.messages;
  const { audioRef, tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { tune, toggleMute, setVolume, submitRequest: coreSubmitRequest, pollRequest } =
    usePlayerActions();
  const { showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  // Listener count now lives in the footer's signal readout (not the header) —
  // normalise the feed's number | { current } | null shape to a plain count.
  const listenerCount =
    listeners == null ? null : typeof listeners === 'number' ? listeners : (listeners.current ?? null);

  // Art-derived ambient wash — extract a couple of colours from the current
  // cover and feed them to the gradient layer behind the player. Same coverSrc
  // shape as CenterStage so the extraction hits the controller's cached proxy.
  const coverSubsonicId = nowPlaying?.subsonic_id ?? null;
  const coverSrc = coverSubsonicId ? client.coverUrl(coverSubsonicId) : null;
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
  // Queue head for CenterStage's "up next" tease. Reduced to the two fields it
  // renders and memoized on them, so the fresh array every /state poll doesn't
  // re-render the memoized stage.
  const nextTitle = state.upcoming?.[0]?.title;
  const nextArtist = state.upcoming?.[0]?.artist;
  const upNext = useMemo<QueueEntry | null>(
    () => (nextTitle ? { title: nextTitle, artist: nextArtist } : null),
    [nextTitle, nextArtist],
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

  // Hydrate ticker preference from localStorage (avoids SSR hydration mismatch).
  useEffect(() => {
    try {
      const v = localStorage.getItem('subwave:ticker');
      if (v != null) setTickerOn(v === '1');
    } catch {}
  }, []);

  // Ticker that increments only on keyboard-driven volume adjusts. The
  // TransportBar watches it to pulse the volume cells; knob drags don't
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
      const data = await coreSubmitRequest(requestText.trim(), requesterName.trim());
      if (data.success) setRequestText('');
      return data;
    } catch {
      toast.error('Request failed. Is the controller up?');
      return { success: false, message: 'Network error.' };
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div
        ref={ambientRef}
        aria-hidden="true"
        className={cn('v3-cover-ambient', coverColors.vibrant && 'v3-cover-ambient-on')}
      />

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
        llmTokens={llmTokens}
        feed={boothFeed}
        djLineOn={tickerOn}
        boothBuddyOn={state.ui?.boothBuddy === true}
        offline={offline}
        upNext={upNext}
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
        {drawer === 'booth'   && <BoothDrawer items={boothFeed} timezone={timezone} locale={locale} />}
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
        {showOverlay && !offline && (
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
    </>
  );
}
