// The "DJ is on the mic" window as a boolean, closing itself on a timer. The
// rule lives in lib/voice-turn.ts; this is just its state machine.

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
    // Measured from the turn's own stamp, not from now: a poll can land a
    // 20s-old link, and an already-expired one must never open the window.
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
