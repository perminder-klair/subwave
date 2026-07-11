'use client';

// First-paint tune-in gate, shared by every skin. Browsers only allow audio
// after a user gesture, so the gate's tap doubles as the audio unblock —
// skins must funnel their initial tune-in affordance through this hook.
//
// Shown on every fresh load until the listener taps it; dismissed permanently
// for the rest of the session once they've tuned in, so a later Tune Out
// doesn't bring the overlay back. When the idle cutoff tears playback down
// (usePlayer, issue #343), the gate returns as the one-tap resume.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { usePlayerActions, usePlayerAudio } from './PlayerCore';

export interface TuneInGate {
  /** Render the skin's tune-in overlay while true (and the stream is up). */
  showTuneIn: boolean;
  /** The overlay's tap handler — dismisses the gate and tunes in. */
  tuneInFromOverlay: () => void;
  /** Tune toggle for shortcuts/palettes — goes through the overlay path
   *  while the gate is up, so Space behaves like tapping it. */
  handleTune: () => void;
}

export function useTuneInGate(): TuneInGate {
  const { tunedIn, idleStopped } = usePlayerAudio();
  const { tune } = usePlayerActions();
  const [showTuneIn, setShowTuneIn] = useState(true);

  const tuneInFromOverlay = () => {
    setShowTuneIn(false);
    tune();
  };

  // Idle cutoff fired: bring the gate back as the one-tap resume and say why
  // playback stopped. Lock-screen Play also resumes, via the media session.
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

  const handleTune = () => {
    if (showTuneIn) tuneInFromOverlay();
    else tune();
  };

  return { showTuneIn, tuneInFromOverlay, handleTune };
}
