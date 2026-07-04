'use client';
// "Play sample" button for the TTS picker. Posts the chosen engine/voice/speed
// to POST /settings/tts/preview, gets back a WAV blob and plays it — so the
// operator can hear a voice before saving. Shared by the Personas voice card and
// the Settings voice tab. The endpoint bypasses the on-air persona AND the
// silent fallback, so an unavailable engine returns a real error message here
// rather than quietly playing Piper. Gain (dB) is a playout-time mix trim and is
// not part of the rendered sample — only voice + speed are auditioned.
import { useEffect, useRef, useState } from 'react';
import type { AdminAuth } from '../../../lib/adminAuth';
import { Btn } from '../ui';

interface VoicePreviewButtonProps {
  engine: string;
  voice: string;
  cloudProvider?: string;
  // Final rate multiplier to audition (server clamps to 0.5–2.0×).
  speed?: number;
  // Kokoro phonemizer language override (e.g. "en-gb", "ja").
  lang?: string;
  adminFetch: AdminAuth['adminFetch'];
  disabled?: boolean;
  className?: string;
}

type PreviewState = 'idle' | 'loading' | 'playing' | 'error';

export function VoicePreviewButton({
  engine, voice, cloudProvider, speed, lang, adminFetch, disabled, className,
}: VoicePreviewButtonProps) {
  const [state, setState] = useState<PreviewState>('idle');
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stop = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
  };

  // Revoke the object URL + stop playback if the card unmounts mid-sample.
  useEffect(() => stop, []);

  const onClick = async () => {
    // Re-click while loading/playing cancels.
    if (state === 'loading' || state === 'playing') { stop(); setState('idle'); return; }
    setError(null);
    setState('loading');
    try {
      const r = await adminFetch('/settings/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine, voice, cloudProvider, speed, lang }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { message?: string };
        setError(j.message || `Preview failed (${r.status})`);
        setState('error');
        return;
      }
      const blob = await r.blob();
      stop();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { stop(); setState('idle'); };
      audio.onerror = () => { stop(); setError('Could not play sample'); setState('error'); };
      await audio.play();
      setState('playing');
    } catch (e) {
      stop();
      setError(e instanceof Error ? e.message : 'Preview failed');
      setState('error');
    }
  };

  const label = state === 'loading' ? 'Synthesizing…' : state === 'playing' ? 'Stop' : 'Play sample';

  return (
    <div className={className}>
      <Btn sm onClick={onClick} disabled={disabled}>{label}</Btn>
      {error && (
        <span className="ml-2 text-[10px] leading-[1.4] text-[var(--danger)]">{error}</span>
      )}
    </div>
  );
}
