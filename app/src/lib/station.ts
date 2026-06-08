// Persisted multi-station config. Stored in AsyncStorage (these are public
// station URLs — no secrets, so no keychain). Shape:
//   { activeStation, recents[], }
// The featured/default station is seeded from app.json `extra.featuredStation`
// (read via expo-constants), not stored here, so an operator can rebrand the
// build by editing one config line.

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { normalizeBase } from './api';

const KEY = 'subwave.stations.v1';
const RECENTS_CAP = 8;

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
    url: normalizeBase(f?.url || 'https://radio.getsubwave.com'),
    name: f?.name || 'SUB/WAVE',
  };
}

export async function loadStations(): Promise<StationStore> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<StationStore>;
    return {
      activeStation: parsed.activeStation ?? null,
      recents: Array.isArray(parsed.recents) ? parsed.recents : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

async function persist(store: StationStore): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* non-fatal */
  }
}

/** Mark a station active and push it to the front of the MRU recents list. */
export async function setActiveStation(ref: StationRef): Promise<StationStore> {
  const url = normalizeBase(ref.url);
  const store = await loadStations();
  const recents = [
    { url, name: ref.name, lastUsed: Date.now() },
    ...store.recents.filter((r) => normalizeBase(r.url) !== url),
  ].slice(0, RECENTS_CAP);
  const next: StationStore = { activeStation: url, recents };
  await persist(next);
  return next;
}

export async function removeRecent(url: string): Promise<StationStore> {
  const norm = normalizeBase(url);
  const store = await loadStations();
  const next: StationStore = {
    activeStation: store.activeStation,
    recents: store.recents.filter((r) => normalizeBase(r.url) !== norm),
  };
  await persist(next);
  return next;
}

export async function clearActiveStation(): Promise<StationStore> {
  const store = await loadStations();
  const next: StationStore = { activeStation: null, recents: store.recents };
  await persist(next);
  return next;
}
