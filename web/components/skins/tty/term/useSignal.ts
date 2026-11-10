'use client';

// The skin's one listener on the music. Several drawings may read it in the
// same frame (the scope pane, the focus scene), so it computes at most once
// per frame and hands back the same Signal. It rides the shared Web Audio
// graph (useAnalyser) and falls back to signal.ts's synthetic walk, locked to
// the track's tempo, wherever that graph can't attach or reads silent.

import { useCallback, useEffect, useRef } from 'react';
import { usePlayerAudio } from '@/components/player/PlayerCore';
import { useAnalyser } from '@/lib/hooks';
import { foldBpm } from '../../shared';
import {
  beatPulse, createSignal, feedSilence, feedSpectrum, feedSynthetic, feedWave, type Signal,
} from './signal';

export interface SignalOptions {
  /** Sound is actually playing. */
  active: boolean;
  /** Lite or reduced motion: nothing animates, so never attach the graph. */
  calm: boolean;
  bpm: number | null | undefined;
  trackStartedAt: number | null;
}

/** Returns `sample(nowMs)` — stable for the life of the skin. */
export function useSignal({ active, calm, bpm, trackStartedAt }: SignalOptions): (nowMs: number) => Signal {
  const { audioRef } = usePlayerAudio();
  const { ready, read, readWave, sampleRate } = useAnalyser(audioRef, active && !calm);

  const live = useRef({ active, ready, read, readWave, sampleRate, bpm, trackStartedAt });
  useEffect(() => {
    live.current = { active, ready, read, readWave, sampleRate, bpm, trackStartedAt };
  }, [active, ready, read, readWave, sampleRate, bpm, trackStartedAt]);

  const sigRef = useRef<Signal | null>(null);
  const lastRef = useRef<number | null>(null);

  return useCallback((nowMs: number) => {
    const sig = (sigRef.current ??= createSignal());
    const last = lastRef.current;
    if (last !== null && nowMs - last < 8) return sig;
    const dt = last === null ? 1 / 30 : Math.min(0.1, Math.max(0, (nowMs - last) / 1000));
    lastRef.current = nowMs;

    const s = live.current;
    sig.active = s.active;
    const period = 60000 / foldBpm(s.bpm, 70, 150);
    const since = s.trackStartedAt == null ? Date.now() : Date.now() - s.trackStartedAt;
    sig.beat = s.active ? beatPulse(since / period) : 0;

    if (!s.active) {
      feedSilence(sig, dt);
      return sig;
    }
    const bins = s.ready ? s.read() : null;
    let heard = false;
    if (bins && s.sampleRate) {
      for (let i = 0; i < bins.length; i += 8) if (bins[i]) { heard = true; break; }
    }
    if (heard && bins && s.sampleRate) {
      feedSpectrum(sig, bins, s.sampleRate, dt);
      const wave = s.readWave();
      if (wave) feedWave(sig, wave);
    } else {
      feedSynthetic(sig, nowMs / 1000, dt);
    }
    return sig;
  }, []);
}
