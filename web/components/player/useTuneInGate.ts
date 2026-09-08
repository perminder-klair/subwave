'use client';

// First-paint tune-in gate, shared by every skin. The tap is the browser's
// required audio-unblock gesture, so skins must funnel their initial tune-in
// affordance through this hook. Shown on every fresh load until tapped, then
// dismissed for the session; the idle cutoff (usePlayer, #343) brings it back
// as the one-tap resume.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { usePlayerActions, usePlayerAudio, usePlayerFeed } from './PlayerCore';

export interface TuneInGate {
  /** The gate is up. Skins key their un-tuned state off this whether or not
   *  the full-bleed overlay is shown. */
  showTuneIn: boolean;
  /** Render the skin's full-bleed tune-in overlay: the gate is up AND the
   *  operator hasn't disabled it (settings.ui.tuneInOverlay). When off,
   *  listeners tune in via the skin's own play button instead. */
  showOverlay: boolean;
  /** The overlay's tap handler — dismisses the gate and tunes in. */
  tuneInFromOverlay: () => void;
  /** Tune toggle for shortcuts/palettes — goes through the overlay path
   *  while the gate is up, so Space behaves like tapping it. */
  handleTune: () => void;
}

export function useTuneInGate(): TuneInGate {
  const { tunedIn, idleStopped } = usePlayerAudio();
  const { tune } = usePlayerActions();
  const { state } = usePlayerFeed();
  // Operator toggle (station-wide, live via /state). Default ON: only an
  // explicit false drops the full-bleed gate.
  const overlayEnabled = state.ui?.tuneInOverlay !== false;
  // Seeded from the live tune state, not `true`: the hook remounts on every
  // skin switch, and a fresh instance during playback must not flash the gate.
  const [showTuneIn, setShowTuneIn] = useState(() => !tunedIn);

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

  // Drop the gate whenever playback is running; covers resume paths that
  // bypass the overlay tap (lock-screen Play goes straight through tune()).
  useEffect(() => {
    if (tunedIn) setShowTuneIn(false);
  }, [tunedIn]);

  const handleTune = () => {
    if (showTuneIn) tuneInFromOverlay();
    else tune();
  };

  return { showTuneIn, showOverlay: showTuneIn && overlayEnabled, tuneInFromOverlay, handleTune };
}
