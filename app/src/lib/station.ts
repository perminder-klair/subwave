// Persisted multi-station config. Public station metadata stays in AsyncStorage;
// HTTP Basic Auth credentials live separately in the platform keychain/keystore.
// Shape:
//   { activeStation, recents[], }
// The featured/default station is seeded from app.json `extra.featuredStation`
// (read via expo-constants), not stored here, so an operator can rebrand the
// build by editing one config line.

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { createCredentialVault } from './credential-vault';
import {
  migrateLegacyStationStore,
  splitStationAddress,
  type StationCredentials,
} from './station-credentials';
import { forgetStoredStation } from './station-store';

const KEY = 'subwave.stations.v1';
const RECENTS_CAP = 8;
const credentialVault = createCredentialVault({
  getItemAsync: (key) =>
    SecureStore.getItemAsync(key, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
  setItemAsync: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
});

export interface StationRef {
  url: string;
  name: string;
  lastUsed?: number;
}

export interface StationStore {
  activeStation: string | null;
  recents: StationRef[];
}

const EMPTY: StationStore = { activeStation: null, recents: [] };

export function featuredStation(): StationRef {
  const f = (Constants.expoConfig?.extra as { featuredStation?: StationRef } | undefined)
    ?.featuredStation;
  return {
    url: splitStationAddress(f?.url || 'https://www.getsubwave.com').base,
    name: f?.name || 'SUB/WAVE',
  };
}

export async function loadStations(): Promise<StationStore> {
  let loaded: StationStore;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<StationStore>;
    loaded = {
      activeStation: parsed.activeStation ?? null,
      recents: Array.isArray(parsed.recents) ? parsed.recents : [],
    };
  } catch {
    return { ...EMPTY };
  }

  const migrated = migrateLegacyStationStore(loaded);
  if (!migrated.changed) return loaded;
  try {
    // Store secrets first. If secure storage is unavailable, leave the legacy
    // record untouched rather than deleting the listener's only credential.
    await credentialVault.merge(migrated.credentials);
    await persist(migrated.store);
    return migrated.store;
  } catch {
    return loaded;
  }
}

export async function loadStationCredentials(
  rawUrl: string,
): Promise<StationCredentials | null> {
  const split = splitStationAddress(rawUrl);
  if (split.credentials) return split.credentials;
  return credentialVault.get(split.base);
}

async function persist(store: StationStore): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* non-fatal */
  }
}

/** Mark a station active and push it to the front of the MRU recents list. */
export async function setActiveStation(
  ref: StationRef,
  credentials?: StationCredentials | null,
): Promise<StationStore> {
  const split = splitStationAddress(ref.url);
  const url = split.base;
  const nextCredentials = credentials === undefined ? split.credentials : credentials;
  // Do not commit a clean station record when its secret could not be saved:
  // that would present a broken recent after the current process exits.
  if (nextCredentials) await credentialVault.set(url, nextCredentials);
  else if (credentials === null) await credentialVault.remove(url);
  const store = await loadStations();
  const recents = [
    { url, name: ref.name, lastUsed: Date.now() },
    ...store.recents.filter((r) => splitStationAddress(r.url).base !== url),
  ].slice(0, RECENTS_CAP);
  const next: StationStore = { activeStation: url, recents };
  await persist(next);
  return next;
}

export async function removeRecent(url: string): Promise<StationStore> {
  return forgetStoredStation(url, {
    load: loadStations,
    removeCredential: (base) => credentialVault.remove(base),
    persist,
  });
}

export async function clearActiveStation(): Promise<StationStore> {
  const store = await loadStations();
  const next: StationStore = { activeStation: null, recents: store.recents };
  await persist(next);
  return next;
}
