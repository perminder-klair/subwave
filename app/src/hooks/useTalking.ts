// The "DJ is on the mic" window as a boolean, closing itself on a timer.
//
// Shared by every surface that swaps the now-playing strip to the persona (the
// lock screen and the Live Activity today). The rule itself lives in
// lib/voice-turn.ts; this is just its state machine.

import { useEffect, useMemo, useState } from 'react';
import { TALKING_LINGER_MS, lastVoiceTurnTime } from '@/lib/voice-turn';
import type { SessionTurn } from '@/lib/types';

export function useTalking(boothFeed: SessionTurn[] | undefined): boolean {
  const [talking, setTalking] = useState(false);
  const lastVoiceTs = useMemo(() => lastVoiceTurnTime(boothFeed), [boothFeed]);

  useEffect(() => {
    if (lastVoiceTs == null) {
      setTalking(false);
      return;
    }
    // The turn may already have aged out by the time we see it (a poll can land
    // a 20s-old link), so the window is measured from the turn's own stamp, not
    // from now — an expired one never opens it at all.
    const remaining = TALKING_LINGER_MS - (Date.now() - lastVoiceTs);
    if (remaining <= 0) {
      setTalking(false);
      return;
    }
    setTalking(true);
    const id = setTimeout(() => setTalking(false), remaining);
    return () => clearTimeout(id);
  }, [lastVoiceTs]);

  return talking;
}
