'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import TopBar from './TopBar';
import CenterStage from './CenterStage';
import Waveform from './Waveform';
import TransportBar from './TransportBar';
import DotRail from './DotRail';
import BroadcastTicker from './BroadcastTicker';
import { Sheet } from './ui/sheet';
import { Toaster } from './ui/toaster';
import SettingsDialog from './SettingsDialog';
import QueueDrawer from './drawers/QueueDrawer';
import HistoryDrawer from './drawers/HistoryDrawer';
import BoothDrawer from './drawers/BoothDrawer';
import RequestDrawer from './drawers/RequestDrawer';
import { useStationFeed } from '../hooks/useStationFeed';
import { usePlayer } from '../hooks/usePlayer';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

const DRAWER_TITLES = {
  queue: 'Up next',
  history: 'Played',
  booth: 'Booth feed',
  request: 'Make a request',
};

export default function PlayerApp({ contained = false }) {
  const { nowPlaying, context, dj, state, elapsed, progress } = useStationFeed();
  const { audioRef, tunedIn, volume, setVolume, tune } = usePlayer();

  const rootRef = useRef(null);
  // Drawers/dialogs portal here when contained so they stay inside the frame.
  const [portalNode, setPortalNode] = useState(null);
  useEffect(() => { if (contained) setPortalNode(rootRef.current); }, [contained]);

  const [requestText, setRequestText] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [drawer, setDrawer] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tickerOn, setTickerOn] = useState(true);

  // Hydrate ticker preference from localStorage (avoids SSR hydration mismatch).
  useEffect(() => {
    try {
      const v = localStorage.getItem('subwave:ticker');
      if (v != null) setTickerOn(v === '1');
    } catch {}
  }, []);
  const toggleTicker = () => {
    setTickerOn(v => {
      const next = !v;
      try { localStorage.setItem('subwave:ticker', next ? '1' : '0'); } catch {}
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
        transmission={state.djLog?.length || 241}
        djName={dj?.name}
        onOpenSettings={() => setSettingsOpen(true)}
        tickerOn={tickerOn}
        onToggleTicker={toggleTicker}
      />

      <BroadcastTicker items={state.djLog} enabled={tickerOn} />

      <CenterStage nowPlaying={nowPlaying} elapsed={elapsed} />

      <Waveform audioRef={audioRef} tunedIn={tunedIn} progress={progress} />

      <DotRail
        counts={{
          queue: state.upcoming?.length ?? 0,
          history: state.history?.length ?? 0,
          booth: state.djLog?.length ?? 0,
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
          />
        )}
      </Sheet>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} container={portalNode} />

      {!contained && <Toaster />}
    </div>
  );
}
