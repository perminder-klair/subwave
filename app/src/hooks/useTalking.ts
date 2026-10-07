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
    // Use the turn stamp so an old poll result cannot reopen an expired window.
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
