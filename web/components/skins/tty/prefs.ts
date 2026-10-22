'use client';

import { useCallback, useEffect, useState } from 'react';

/** A listener's own setting, remembered per browser. Hydrated after mount so
 *  the server render and the first client render agree; storage that throws
 *  (private mode, blocked site data) just means it isn't remembered. The
 *  third value turns true once storage has been read, for a caller that
 *  would otherwise build something on the fallback only to swap it a commit
 *  later. */
export function useStoredPref<T extends string>(
  key: string,
  fallback: T,
  valid: (v: unknown) => v is T,
): [T, (v: T) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (valid(stored)) setValue(stored);
    } catch {}
    setLoaded(true);
    // `valid` is a module-level guard; the key never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(key, v); } catch {}
  }, [key]);
  return [value, set, loaded];
}
