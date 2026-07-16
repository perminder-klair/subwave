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
import { usePlayerActions, usePlayerAudio, usePlayerFeed } from './PlayerCore';

export interface TuneInGate {
  /** The gate is up — the listener hasn't tuned in yet. Skins key their
   *  un-tuned state off this (paused time display, keyboard focus, etc.),
   *  regardless of whether the full-bleed overlay is shown. */
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
  // Operator toggle (station-wide, live via /state). Default ON — anything
  // other than an explicit false (including undefined before /state resolves)
  // keeps the full-bleed gate, preserving pre-toggle behavior.
  const overlayEnabled = state.ui?.tuneInOverlay !== false;
  // Seeded from the live tune state, not `true`: the hook remounts on every
  // skin switch (gate state is per-skin), and a fresh instance while playback
  // is already running must not paint the gate for a frame before the
  // tunedIn effect below drops it.
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

  return { showTuneIn, showOverlay: showTuneIn && overlayEnabled, tuneInFromOverlay, handleTune };
}
