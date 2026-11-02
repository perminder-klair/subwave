// This device's choice to show lyrics, on by default. Hidden until the stored
// choice is read, so a listener who turned them off never sees them flash on
// at launch, and no lyrics are asked for on their behalf.

import { useCallback, useEffect, useState } from 'react';
import { loadLyricsShown, saveLyricsShown } from '@/lib/lyrics-prefs';

export interface LyricsPreference {
  shown: boolean;
  toggle: () => void;
}

export function useLyricsPreference(): LyricsPreference {
  const [shown, setShown] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadLyricsShown().then((v) => {
      if (!cancelled) setShown((prev) => prev ?? v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const toggle = useCallback(() => {
    setShown((prev) => {
      const next = !(prev ?? true);
      void saveLyricsShown(next);
      return next;
    });
  }, []);
  return { shown: shown === true, toggle };
}
