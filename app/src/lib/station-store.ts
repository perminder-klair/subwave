import {
  splitStationAddress,
  type StoredStationRef,
  type StoredStationStore,
} from './station-credentials';

export interface ForgetStoredStationDeps {
  load(): Promise<StoredStationStore>;
  removeCredential(base: string): Promise<void>;
  persist(store: StoredStationStore): Promise<void>;
}

/** Forget a station in an order that cannot orphan retained legacy userinfo:
 * load/migrate first, delete the secure credential second, then hide the
 * public recent only after both operations succeeded. */
export async function forgetStoredStation(
  rawUrl: string,
  deps: ForgetStoredStationDeps,
): Promise<StoredStationStore> {
  const norm = splitStationAddress(rawUrl).base;
  const store = await deps.load();
  await deps.removeCredential(norm);
  const next: StoredStationStore = {
    activeStation: store.activeStation,
    recents: store.recents.filter((recent) => splitStationAddress(recent.url).base !== norm),
  };
  await deps.persist(next);
  return next;
}

/** Whether a stream URL (StationApi.streamUrl) is one of this station's
 *  mounts. Compared on the credential-free base, which is what streamUrl()
 *  builds on. usePlayer uses it to keep a stream a station switch from Siri
 *  started (src/intents/tune.ts) rather than stopping it as stale. */
export function streamBelongsTo(streamUrl: string, rawBase: string): boolean {
  const base = splitStationAddress(rawBase).base;
  return !!base && streamUrl.startsWith(`${base}/`);
}

/** A saved station by the id Siri and Spotlight know it by: its
 *  credential-free base URL. */
export function findSavedStation(
  recents: StoredStationRef[],
  id: string,
): StoredStationRef | null {
  const wanted = splitStationAddress(id).base;
  return recents.find((r) => splitStationAddress(r.url).base === wanted) ?? null;
}

export interface MirroredStation {
  id: string;
  name: string;
}

/** The saved stations as Siri, Shortcuts and Spotlight see them
 *  (modules/app-intents setStations): names and credential-free bases only,
 *  never a login or a station password. A station saved without a name goes
 *  by its host. */
export function stationsForSiri(recents: StoredStationRef[]): MirroredStation[] {
  const seen = new Set<string>();
  const out: MirroredStation[] = [];
  for (const r of recents) {
    const id = splitStationAddress(r.url).base;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: r.name?.trim() || id.replace(/^https?:\/\//i, '') });
  }
  return out;
}

/** Stations a spoken term names ("Hey Google, play Night Shift on SUB/WAVE"),
 *  compared folded because speech arrives as "chill wave radio": an exact name
 *  first, else a name containing the term or contained in it. A generic word
 *  names no station, so "play radio" stays on the one listened to last.
 *  The same rule as Siri's, SavedStations.matching in
 *  targets/live-activity/_shared/StationEntities.swift: change both. */
export function matchStations(stations: MirroredStation[], term: string): MirroredStation[] {
  const wanted = foldName(term);
  if (wanted.length < 3 || GENERIC_TERMS.has(wanted)) return [];
  const exact = stations.filter((s) => foldName(s.name) === wanted);
  if (exact.length) return exact;
  return stations.filter((s) => {
    const name = foldName(s.name);
    return !!name && (name.includes(wanted) || wanted.includes(name));
  });
}

const GENERIC_TERMS = new Set([
  'radio',
  'theradio',
  'station',
  'mystation',
  'music',
  'somemusic',
  'live',
  'subwave',
]);

/** Lowercased, accents dropped, letters and digits only. */
function foldName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}
