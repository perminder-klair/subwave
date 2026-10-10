// Gate cosmetic work on active; audio continues in the background.
// iOS also pauses this work during transient inactive states.

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
