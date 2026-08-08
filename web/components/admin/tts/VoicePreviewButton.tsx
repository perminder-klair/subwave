'use client';
// "Play sample" for the TTS pickers: POST /settings/tts/preview → a WAV blob.
// The endpoint bypasses the on-air persona AND the silent fallback, so an
// unavailable engine returns a real error here rather than quietly playing Piper.
// Gain (dB) is a playout-time mix trim, so only voice + speed are auditioned, and
// a sample is discarded as stale the moment either changes.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AdminAuth } from '../../../lib/adminAuth';
import { Btn } from '../ui';
import {
  AudioPlayer,
  AudioPlayerControlBar,
  AudioPlayerElement,
  AudioPlayerMuteButton,
  AudioPlayerPlayButton,
  AudioPlayerTimeDisplay,
  AudioPlayerTimeRange,
} from '../../ai-elements/audio-player';
import { fetchPreviewSample } from './previewApi';

interface VoicePreviewButtonProps {
  engine: string;
  voice: string;
  cloudProvider?: string;
  cloudModel?: string;
  // Final rate multiplier to audition (server clamps to 0.5–2.0×).
  speed?: number;
  // Kokoro phonemizer language override (e.g. "en-gb", "ja").
  lang?: string;
  // Persona's free-text on-air language ("Turkish", "Türkçe") — the server
  // renders the sample sentence in this language when it recognizes it.
  language?: string;
  // Explicit sample text (overrides the default/localized sentence).
  text?: string;
  // Unsaved corrections override — tests rules that haven't been saved yet.
  corrections?: { from: string; to: string }[];
  // Unsaved ElevenLabs sliders (issue #696), so the sample auditions the CURRENT
  // positions. Only meaningful for cloud + elevenlabs; ignored server-side otherwise.
  voiceSettings?: {
    voiceStability: number;
    voiceStyle: number;
    voiceSimilarityBoost: number;
    voiceUseSpeakerBoost: boolean;
  };
  fishSettings?: {
    temperature: number;
    topP: number;
    latency: 'low' | 'normal' | 'balanced';
  };
  adminFetch: AdminAuth['adminFetch'];
  disabled?: boolean;
  className?: string;
}

type PreviewState = 'idle' | 'loading' | 'error';

export function VoicePreviewButton({
  engine, voice, cloudProvider, cloudModel, speed, lang, language, text, corrections, voiceSettings, fishSettings, adminFetch, disabled, className,
}: VoicePreviewButtonProps) {
  const [state, setState] = useState<PreviewState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const discardSample = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setSampleUrl(null);
  }, []);

  // Unmounting mid-sample must abort synthesis and revoke the object URL.
  useEffect(() => () => discardSample(), [discardSample]);

  // The player must never replay the old voice under a new label. voiceSettings is
  // deliberately absent from the deps: it's an unstable inline object at the call site.
  useEffect(() => {
    discardSample();
    setState('idle');
    setError(null);
  }, [engine, voice, cloudProvider, cloudModel, speed, lang, language, fishSettings?.temperature, fishSettings?.topP, fishSettings?.latency, discardSample]);

  const onClick = async () => {
    // Re-click while synthesizing cancels the request.
    if (state === 'loading') { discardSample(); setState('idle'); return; }
    setError(null);
    setState('loading');
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetchPreviewSample(
        adminFetch,
        { engine, voice, cloudProvider, cloudModel, speed, lang, language, text, corrections, voiceSettings, fishSettings },
        ac.signal,
      );
      if (ac.signal.aborted) return;
      if (!res.ok) { setError(res.message); setState('error'); return; }
      const url = URL.createObjectURL(res.blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setSampleUrl(url);
      setState('idle');
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof Error ? e.message : 'Preview failed');
      setState('error');
    }
  };

  const label = state === 'loading' ? 'Synthesizing…' : sampleUrl ? 'New sample' : 'Play sample';

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <Btn sm onClick={onClick} disabled={disabled}>{label}</Btn>
        {error && (
          <span className="text-[10px] leading-[1.4] text-[var(--danger)]">{error}</span>
        )}
      </div>
      {sampleUrl && (
        // `key` remounts the element per sample so autoPlay fires again on
        // re-synthesis. Theming rides the vendored CSS-var hooks.
        <AudioPlayer
          key={sampleUrl}
          className="mt-2 block w-fit"
          style={{ '--media-font': 'var(--font-mono)' } as CSSProperties}
        >
          <AudioPlayerElement
            src={sampleUrl}
            autoPlay
            onError={() => { setError('Could not play sample'); setState('error'); }}
          />
          <AudioPlayerControlBar>
            <AudioPlayerPlayButton />
            <AudioPlayerTimeRange className="w-32" />
            <AudioPlayerTimeDisplay showDuration className="text-[10px]" />
            <AudioPlayerMuteButton />
          </AudioPlayerControlBar>
        </AudioPlayer>
      )}
    </div>
  );
}
