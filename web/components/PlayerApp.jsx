'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { History, Mic } from 'lucide-react';
import TopBar from './TopBar';
import CenterStage from './CenterStage';
import Waveform from './Waveform';
import TransportBar from './TransportBar';
import DotRail from './DotRail';
import { Sheet } from './ui/sheet';
import { Toaster } from './ui/toaster';
import QueueDrawer from './drawers/QueueDrawer';
import HistoryDrawer from './drawers/HistoryDrawer';
import BoothDrawer from './drawers/BoothDrawer';
import RequestDrawer from './drawers/RequestDrawer';
import { useStationFeed } from '../hooks/useStationFeed';
import { usePlayer } from '../hooks/usePlayer';
import { useMediaSession } from '../hooks/useMediaSession';
import { getStoredTheme, setTheme as persistTheme } from '../lib/theme';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

const DRAWER_TITLES = {
  queue: 'Up next',
  history: 'Played',
  booth: 'Booth feed',
  request: 'Make a request',
};

export default function PlayerApp({ contained = false }) {
  const { nowPlaying, context, dj, activeShow, listeners, state, elapsed, progress } = useStationFeed();
  const { audioRef, tunedIn, volume, setVolume, tune } = usePlayer();

  // Wire OS-level media controls (lock screen, headphones, car display).
  // No onSkip on the public listener — a stray AirPods double-tap shouldn't
  // skip the song for every other listener on the station.
  useMediaSession({ tunedIn, nowPlaying, audioRef, onTune: tune });

  const rootRef = useRef(null);
  // Drawers/dialogs portal here when contained so they stay inside the frame.
  const [portalNode, setPortalNode] = useState(null);
  useEffect(() => { if (contained) setPortalNode(rootRef.current); }, [contained]);

  const [requestText, setRequestText] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [drawer, setDrawer] = useState(null);
  const [tickerOn, setTickerOn] = useState(true);
  const [theme, setTheme] = useState('light');

  // Hydrate ticker preference from localStorage (avoids SSR hydration mismatch).
  useEffect(() => {
    try {
      const v = localStorage.getItem('subwave:ticker');
      if (v != null) setTickerOn(v === '1');
    } catch {}
  }, []);

  // Resolve the *applied* theme for the toggle icon. If the user has never
  // chosen manually, `getStoredTheme()` returns 'system' and we fall through
  // to prefers-color-scheme. Persisting via setTheme() commits to a manual
  // mode (writes to localStorage + sets <html data-theme>).
  useEffect(() => {
    const stored = getStoredTheme();
    if (stored === 'light' || stored === 'dark') {
      setTheme(stored);
      return;
    }
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark ? 'dark' : 'light');
  }, []);
  const toggleTheme = () => {
    setTheme(t => {
      const next = t === 'dark' ? 'light' : 'dark';
      persistTheme(next);
      return next;
    });
  };

  const submitRequest = async () => {
    if (!requestText.trim() || isSubmitting) return null;
    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: requestText.trim(), name: requesterName.trim() }),
      });
      const data = await res.json();
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
    <div
      ref={rootRef}
      className={`${contained ? 'absolute' : 'fixed'} inset-0 overflow-hidden`}
      style={{ background: 'var(--bg)', color: 'var(--ink)' }}
    >
      <audio ref={audioRef} crossOrigin="anonymous" preload="auto" />

      <TopBar
        tunedIn={tunedIn}
        context={context}
        djName={dj?.name}
        activeShow={activeShow}
        listeners={listeners}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <CenterStage nowPlaying={nowPlaying} elapsed={elapsed} />

      <Waveform audioRef={audioRef} tunedIn={tunedIn} progress={progress} />

      <DotRail
        counts={{
          queue: state.upcoming?.length ?? 0,
          history: <History size={18} strokeWidth={1.5} />,
          booth: <Mic size={18} strokeWidth={1.5} />,
        }}
        active={drawer}
        onSelect={setDrawer}
      />

      <TransportBar
        tunedIn={tunedIn}
        onTune={tune}
        volume={volume}
        setVolume={setVolume}
        nowPlaying={nowPlaying}
        elapsed={elapsed}
        djLog={state.djLog}
        tickerOn={tickerOn}
      />

      <Sheet
        open={drawer != null}
        onOpenChange={(v) => { if (!v) setDrawer(null); }}
        title={drawer ? DRAWER_TITLES[drawer] : ''}
        container={portalNode}
      >
        {drawer === 'queue'   && <QueueDrawer items={state.upcoming} />}
        {drawer === 'history' && <HistoryDrawer items={state.history} />}
        {drawer === 'booth'   && <BoothDrawer items={state.djLog} />}
        {drawer === 'request' && (
          <RequestDrawer
            requestText={requestText} setRequestText={setRequestText}
            requesterName={requesterName} setRequesterName={setRequesterName}
            isSubmitting={isSubmitting}
            onSubmit={submitRequest}
            onClose={() => setDrawer(null)}
            nowPlaying={nowPlaying}
            context={context}
          />
        )}
      </Sheet>

      {!contained && <Toaster />}
    </div>
  );
}
