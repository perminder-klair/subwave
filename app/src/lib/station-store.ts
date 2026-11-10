import { splitStationAddress, type StoredStationStore } from './station-credentials';

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
