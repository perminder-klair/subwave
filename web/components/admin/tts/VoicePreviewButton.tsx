'use client';
// "Play sample" button for the TTS picker. Posts the chosen engine/voice/speed
// to POST /settings/tts/preview, gets back a WAV blob and plays it — so the
// operator can hear a voice before saving. Shared by the Personas voice card and
// the Settings voice tab. The endpoint bypasses the on-air persona AND the
// silent fallback, so an unavailable engine returns a real error message here
// rather than quietly playing Piper. Gain (dB) is a playout-time mix trim and is
// not part of the rendered sample — only voice + speed are auditioned.
//
// Once a sample is synthesized it renders as an ai-elements AudioPlayer
// (media-chrome under the hood) instead of a bare play/stop toggle: the clip
// auto-plays on arrival (same behavior as before) and stays scrubbable /
// replayable until the audition parameters change. A sample auditions one
// exact engine/voice/speed combination, so it is discarded as stale the moment
// any of those change.
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
  // Final rate multiplier to audition (server clamps to 0.5–2.0×).
  speed?: number;
  // Kokoro phonemizer language override (e.g. "en-gb", "ja").
  lang?: string;
  // Unsaved ElevenLabs voice_settings sliders (issue #696) — sent so the sample
  // auditions the CURRENT slider positions, not the last-saved values. Only
  // meaningful when engine is 'cloud' with the elevenlabs provider; the server
  // ignores it everywhere else.
  voiceSettings?: {
    voiceStability: number;
    voiceStyle: number;
    voiceSimilarityBoost: number;
    voiceUseSpeakerBoost: boolean;
  };
  adminFetch: AdminAuth['adminFetch'];
  disabled?: boolean;
  className?: string;
}

type PreviewState = 'idle' | 'loading' | 'error';

export function VoicePreviewButton({
  engine, voice, cloudProvider, speed, lang, voiceSettings, adminFetch, disabled, className,
}: VoicePreviewButtonProps) {
  const [state, setState] = useState<PreviewState>('idle');
  const [error, setError] = useState<string | null>(null);
  // Object URL of the rendered sample; non-null = the AudioPlayer is shown.
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight synthesis and revoke the current object URL.
  const discardSample = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setSampleUrl(null);
  }, []);

  // Revoke the object URL + abort synthesis if the card unmounts mid-sample.
  useEffect(() => () => discardSample(), [discardSample]);

  // Drop a stale sample when the auditioned parameters change — the player
  // must never replay the old voice under a new label. (voiceSettings is
  // deliberately absent: it's an unstable inline object at the call site, and
  // the pre-AudioPlayer version had the same blind spot.)
  useEffect(() => {
    discardSample();
    setState('idle');
    setError(null);
  }, [engine, voice, cloudProvider, speed, lang, discardSample]);

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
        { engine, voice, cloudProvider, speed, lang, voiceSettings },
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
        // Compact single-row transport for a seconds-long clip: play,
        // scrubbable time range, elapsed/total readout, mute — no seek-jump
        // buttons. `key` remounts the element per sample so autoPlay fires
        // again on re-synthesis. Theming rides the vendored CSS-var hooks:
        // the shadcn bridge tokens already resolve to newsprint ink/vermilion,
        // and the mono face keeps the timecode reading like a data readout.
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
