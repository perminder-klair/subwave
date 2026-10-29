import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { teardown } from '@/audio/player';
import { createApi, type StationApi } from '@/lib/api';
import {
  clearActiveStation,
  clearStationPassword,
  featuredStation,
  loadStationCredentials,
  loadStationPassword,
  loadStations,
  removeRecent,
  saveStationCredentials,
  saveStationPassword,
  setActiveStation,
  type StationRef,
  type StationStore,
} from '@/lib/station';
import { splitStationAddress, type StationCredentials } from '@/lib/station-credentials';

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
  /** The active station has a saved "Station login". */
  hasLogin: boolean;
  /** Replace or remove any saved station's login (#1873). Secure storage is
   *  written first; the active station's client then picks it up. */
  saveLogin: (url: string, credentials: StationCredentials | null) => Promise<void>;
  /** The active station's private-station password (#478), or null. */
  stationPassword: string | null;
  /** The active station's "Station login" password, or null. Only consulted
   *  as a candidate station password — see verifyStoredPasswords. */
  loginPassword: string | null;
  /** Save a password proven by POST /station-auth for the active station. */
  rememberStationPassword: (password: string) => Promise<void>;
  /** Forget the active station's password (it was rejected). */
  forgetStationPassword: () => Promise<void>;
  /** Whether any saved station has a station password on this device. */
  stationPasswordSaved: (url: string) => Promise<boolean>;
  /** Forget any saved station's password because the listener asked to.
   *  Throws when secure storage cannot be written. */
  forgetStationPasswordFor: (url: string) => Promise<void>;
  forgetStation: (url: string) => Promise<void>;
  /** Clear the active station — sends the app back to onboarding. */
  signOut: () => Promise<void>;
}

const Ctx = createContext<StationContextValue | null>(null);

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
    loadStations().then(async (s) => {
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
      if (alive) {
        setStore(s);
        setCredentials(activeCredentials);
        setStationPassword(activePassword);
        setReady(true);
      }
    }).catch(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [setStationPassword]);

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
  // The active station answers from the ref, which holds a password the
  // keychain failed to save too, and keeps this callback's identity stable.
  const stationPasswordSaved = useCallback(async (url: string) => {
    if (splitStationAddress(url).base === base) return stationPasswordRef.current !== null;
    return (await loadStationPassword(url)) !== null;
  }, [base]);
  const forgetStationPasswordFor = useCallback(async (url: string) => {
    await clearStationPassword(url);
    if (splitStationAddress(url).base === base) setStationPassword(null);
  }, [base, setStationPassword]);
  const saveLogin = useCallback(async (url: string, next: StationCredentials | null) => {
    await saveStationCredentials(url, next);
    if (splitStationAddress(url).base === base) setCredentials(next);
  }, [base]);

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
      hasLogin: credentials !== null,
      saveLogin,
      stationPassword,
      loginPassword: credentials?.password || null,
      rememberStationPassword,
      forgetStationPassword,
      stationPasswordSaved,
      forgetStationPasswordFor,
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
      saveLogin,
      stationPassword,
      credentials,
      rememberStationPassword,
      forgetStationPassword,
      stationPasswordSaved,
      forgetStationPasswordFor,
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
