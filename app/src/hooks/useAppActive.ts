// Foreground gate for timers and cosmetic animations. The app is a radio:
// when backgrounded, RNTP keeps the audio alive on its own, so everything
// else — feed polls, health probes, the synthesised spectrum, Animated loops —
// should stop burning battery and data. iOS reports a transient 'inactive'
// during control-centre pulls and app switches; treating only 'active' as
// foreground means we pause through those too, which is harmless (effects
// re-run and catch up the moment the state returns to 'active').

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
