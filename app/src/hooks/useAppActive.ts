// Foreground gate for timers and cosmetic animations: RNTP keeps the audio
// alive when backgrounded, so polls, probes and animations should stop. iOS
// reports a transient 'inactive' during control-centre pulls, and only
// 'active' counts as foreground, so those pause too and catch up on return.

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);

  return active;
}
