'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import TopBar from '../components/TopBar';
import CenterStage from '../components/CenterStage';
import Waveform from '../components/Waveform';
import TransportBar from '../components/TransportBar';
import DotRail from '../components/DotRail';
import { Sheet } from '../components/ui/sheet';
import { Toaster } from '../components/ui/toaster';
import SettingsDialog from '../components/SettingsDialog';
import QueueDrawer from '../components/drawers/QueueDrawer';
import HistoryDrawer from '../components/drawers/HistoryDrawer';
import BoothDrawer from '../components/drawers/BoothDrawer';
import RequestDrawer from '../components/drawers/RequestDrawer';

const STREAM_URL = process.env.NEXT_PUBLIC_STREAM_URL || '/stream.mp3';
const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

const DRAWER_TITLES = {
  queue: 'Up next',
  history: 'Played',
  booth: 'Booth feed',
  request: 'Make a request',
};

export default function ListenerPage() {
  const [tunedIn, setTunedIn] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [context, setContext] = useState(null);
  const [state, setState] = useState({ upcoming: [], history: [], djLog: [] });
  const [requestText, setRequestText] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [drawer, setDrawer] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const audioRef = useRef(null);
  const trackStartRef = useRef(null);

  // 5s polling from the controller — unchanged shape from the v1 page.
  useEffect(() => {
    const tick = async () => {
      try {
        const [npRes, stRes] = await Promise.all([
          fetch(`${API_URL}/now-playing`).then(r => r.json()),
          fetch(`${API_URL}/state`).then(r => r.json()),
        ]);
        setNowPlaying(prev => {
          if (npRes.nowPlaying?.title !== prev?.title || npRes.nowPlaying?.artist !== prev?.artist) {
            trackStartRef.current = Date.now();
          }
          return npRes.nowPlaying;
        });
        setContext(npRes.context);
        setState(stRes);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  // 1s elapsed tick — controller's now-playing doesn't expose progress directly,
  // so we estimate from track-change timestamps. Resets when title/artist flips.
  useEffect(() => {
    const id = setInterval(() => {
      if (trackStartRef.current) {
        setElapsed(Math.floor((Date.now() - trackStartRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const tuneIn = () => {
    if (!audioRef.current) return;
    if (tunedIn) {
      audioRef.current.pause();
      audioRef.current.src = '';
      setTunedIn(false);
    } else {
      audioRef.current.src = `${STREAM_URL}?t=${Date.now()}`;
      audioRef.current.volume = volume;
      audioRef.current.play().catch(err => console.error('Play failed:', err));
      setTunedIn(true);
    }
  };

  // Returns the parsed response so the drawer can render its own success card.
  // Drawer also owns auto-close; page just clears the textarea on success.
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

  const duration = nowPlaying?.duration ?? 0;
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{ background: 'var(--bg)', color: 'var(--ink)' }}
    >
      <audio ref={audioRef} crossOrigin="anonymous" preload="auto" />

      <TopBar
        tunedIn={tunedIn}
        context={context}
        transmission={state.djLog?.length || 241}
        onOpenSettings={() => setSettingsOpen(true)}
      />

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
        onTune={tuneIn}
        volume={volume}
        setVolume={setVolume}
        nowPlaying={nowPlaying}
        elapsed={elapsed}
      />

      <Sheet
        open={drawer != null}
        onOpenChange={(v) => { if (!v) setDrawer(null); }}
        title={drawer ? DRAWER_TITLES[drawer] : ''}
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

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <Toaster />
    </div>
  );
}
