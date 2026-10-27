import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { setStations } from '../../modules/app-intents';
import { teardown } from '@/audio/player';
import { createApi, type StationApi } from '@/lib/api';
import {
  clearActiveStation,
  clearStationPassword,
  featuredStation,
  loadStationCredentials,
  loadStationPassword,
  loadStations,
  onStationStoreChanged,
  removeRecent,
  saveStationPassword,
  setActiveStation,
  type StationRef,
  type StationStore,
} from '@/lib/station';
import type { StationCredentials } from '@/lib/station-credentials';
import { stationsForSiri } from '@/lib/station-store';

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
  /** The active station's private-station password (#478), or null. */
  stationPassword: string | null;
  /** The active station's "Station login" password, or null. Only consulted
   *  as a candidate station password — see verifyStoredPasswords. */
  loginPassword: string | null;
  /** Save a password proven by POST /station-auth for the active station. */
  rememberStationPassword: (password: string) => Promise<void>;
  /** Forget the active station's password (it was rejected). */
  forgetStationPassword: () => Promise<void>;
  forgetStation: (url: string) => Promise<void>;
  /** Clear the active station — sends the app back to onboarding. */
  signOut: () => Promise<void>;
}

const Ctx = createContext<StationContextValue | null>(null);

/** The stored store plus the active station's login and password, as the
 *  screens need them. A keychain failure leaves either null rather than
 *  failing the read. */
async function readStationState(): Promise<{
  store: StationStore;
  credentials: StationCredentials | null;
  password: string | null;
}> {
  const s = await loadStations();
  let activeCredentials: StationCredentials | null = null;
  let activePassword: string | null = null;
  try {
    activeCredentials = s.activeStation
      ? await loadStationCredentials(s.activeStation)
      : null;
  } catch {
    // Boot without credentials if the keychain fails; later actions report failure
    // and leave the vault intact.
  }
  try {
    activePassword = s.activeStation ? await loadStationPassword(s.activeStation) : null;
  } catch {
    // Same: a locked station then asks again rather than failing to boot.
  }
  return { store: s, credentials: activeCredentials, password: activePassword };
}

export function StationProvider({ children }: { children: React.ReactNode }) {
  const [store, setStore] = useState<StationStore>({ activeStation: null, recents: [] });
  const [credentials, setCredentials] = useState<StationCredentials | null>(null);
  // State for consumers; the ref for the API client, which reads it at call
  // time so a newly unlocked station reaches the very next tune.
  const [stationPassword, setStationPasswordState] = useState<string | null>(null);
  const stationPasswordRef = useRef<string | null>(null);
  const setStationPassword = useCallback((password: string | null) => {
    stationPasswordRef.current = password;
    setStationPasswordState(password);
  }, []);
  const [ready, setReady] = useState(false);
  const featured = useMemo(() => featuredStation(), []);

  useEffect(() => {
    let alive = true;
    readStationState().then((s) => {
      if (alive) {
        setStore(s.store);
        setCredentials(s.credentials);
        setStationPassword(s.password);
        setReady(true);
      }
    }).catch(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [setStationPassword]);

  // A station switch from Siri, Shortcuts or Spotlight (src/intents/tune.ts)
  // writes the store and starts the new stream itself; follow it. No teardown,
  // unlike selectStation: the stream already playing is the new station's.
  useEffect(
    () =>
      onStationStoreChanged(() => {
        readStationState()
          .then((s) => {
            setCredentials(s.credentials);
            setStationPassword(s.password);
            setStore(s.store);
          })
          .catch(() => {});
      }),
    [setStationPassword],
  );

  const selectStation = useCallback(async (
    ref: StationRef,
    suppliedCredentials?: StationCredentials | null,
  ) => {
    const nextCredentials = suppliedCredentials === undefined
      ? await loadStationCredentials(ref.url)
      : suppliedCredentials;
    // Persist new credentials before interrupting playback; saved switches reuse the vault entry.
    const next = await setActiveStation(
      ref,
      suppliedCredentials === undefined ? undefined : nextCredentials,
    );
    const nextPassword = await loadStationPassword(ref.url).catch(() => null);
    // Stop playback before changing the base consumed by every screen.
    await teardown();
    setCredentials(nextCredentials);
    setStationPassword(nextPassword);
    setStore(next);
  }, [setStationPassword]);

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
    setStationPassword(null);
    setStore(next);
  }, [setStationPassword]);

  const base = store.activeStation;
  const rememberStationPassword = useCallback(async (password: string) => {
    if (!base) return;
    // Use it now even if the keychain write fails; it just won't survive a relaunch.
    setStationPassword(password);
    await saveStationPassword(base, password).catch(() => {});
  }, [base, setStationPassword]);
  const forgetStationPassword = useCallback(async () => {
    if (!base) return;
    setStationPassword(null);
    await clearStationPassword(base).catch(() => {});
  }, [base, setStationPassword]);

  const api = useMemo(
    // createApi stores the getter and calls it only when a stream URL is built
    // (tune, reconnect, cast) or a station-gated read is sent (lyrics) — never
    // during render.
    // eslint-disable-next-line react-hooks/refs
    () => (base ? createApi(base, credentials, () => stationPasswordRef.current) : null),
    [base, credentials],
  );
  const name = useMemo(() => {
    if (!base) return null;
    return store.recents.find((r) => r.url === base)?.name ?? null;
  }, [base, store.recents]);

  // Siri, Shortcuts and Spotlight know the saved stations by name, and cannot
  // read this store.
  useEffect(() => {
    if (ready) setStations(base, stationsForSiri(store.recents));
  }, [ready, base, store.recents]);

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
      stationPassword,
      loginPassword: credentials?.password || null,
      rememberStationPassword,
      forgetStationPassword,
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
      stationPassword,
      credentials,
      rememberStationPassword,
      forgetStationPassword,
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
