// Provides the active station's runtime API client to the whole tree, plus the
// recents list and the switch/forget actions. This is the native replacement
// for the web's build-time NEXT_PUBLIC_API_URL — `api` here is rebuilt whenever
// the active station changes, and every hook/screen reads `api`/`base` from it.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { teardown } from '@/audio/player';
import { createApi, type StationApi } from '@/lib/api';
import {
  clearActiveStation,
  featuredStation,
  loadStationCredentials,
  loadStations,
  removeRecent,
  setActiveStation,
  type StationRef,
  type StationStore,
} from '@/lib/station';
import type { StationCredentials } from '@/lib/station-credentials';

interface StationContextValue {
  /** True until the persisted store has loaded. */
  ready: boolean;
  /** The active station's base URL, or null when none is chosen yet. */
  base: string | null;
  /** A client bound to `base`, or null when no station is active. */
  api: StationApi | null;
  /** Display name of the active station (best-effort, from recents). */
  name: string | null;
  recents: StationRef[];
  featured: StationRef;
  /** Switch to a station (also pushes it to the front of recents). */
  selectStation: (
    ref: StationRef,
    credentials?: StationCredentials | null,
  ) => Promise<void>;
  credentialsFor: (url: string) => Promise<StationCredentials | null>;
  forgetStation: (url: string) => Promise<void>;
  /** Clear the active station — sends the app back to onboarding. */
  signOut: () => Promise<void>;
}

const Ctx = createContext<StationContextValue | null>(null);

export function StationProvider({ children }: { children: React.ReactNode }) {
  const [store, setStore] = useState<StationStore>({ activeStation: null, recents: [] });
  const [credentials, setCredentials] = useState<StationCredentials | null>(null);
  const [ready, setReady] = useState(false);
  const featured = useMemo(() => featuredStation(), []);

  useEffect(() => {
    let alive = true;
    loadStations().then(async (s) => {
      const activeCredentials = s.activeStation
        ? await loadStationCredentials(s.activeStation)
        : null;
      if (alive) {
        setStore(s);
        setCredentials(activeCredentials);
        setReady(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const selectStation = useCallback(async (
    ref: StationRef,
    suppliedCredentials?: StationCredentials | null,
  ) => {
    // Single choke point for re-pointing the app: stop the current station's
    // audio BEFORE the base changes, so every caller (stations screen,
    // onboarding add-station) gets the teardown for free.
    await teardown();
    const nextCredentials = suppliedCredentials === undefined
      ? await loadStationCredentials(ref.url)
      : suppliedCredentials;
    const next = await setActiveStation(ref, nextCredentials);
    setCredentials(nextCredentials);
    setStore(next);
  }, []);

  const credentialsFor = useCallback(
    (url: string) => loadStationCredentials(url),
    [],
  );

  const forgetStation = useCallback(async (url: string) => {
    const next = await removeRecent(url);
    setStore(next);
  }, []);

  const signOut = useCallback(async () => {
    await teardown();
    const next = await clearActiveStation();
    setCredentials(null);
    setStore(next);
  }, []);

  const base = store.activeStation;
  const api = useMemo(() => (base ? createApi(base, credentials) : null), [base, credentials]);
  const name = useMemo(() => {
    if (!base) return null;
    return store.recents.find((r) => r.url === base)?.name ?? null;
  }, [base, store.recents]);

  const value = useMemo<StationContextValue>(
    () => ({
      ready,
      base,
      api,
      name,
      recents: store.recents,
      featured,
      selectStation,
      credentialsFor,
      forgetStation,
      signOut,
    }),
    [
      ready,
      base,
      api,
      name,
      store.recents,
      featured,
      selectStation,
      credentialsFor,
      forgetStation,
      signOut,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStation(): StationContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStation must be used within StationProvider');
  return v;
}

/** Convenience: the active API client, throwing if no station is active. Use
 *  only inside the player tree where a station is guaranteed. */
export function useStationApi(): StationApi {
  const { api } = useStation();
  if (!api) throw new Error('No active station');
  return api;
}
