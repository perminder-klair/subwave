// The station an App Intent acts on: the one the listener tuned to last, read
// from storage the way StationContext reads it at boot. An intent can run
// before any screen has mounted, so it cannot borrow the context's client.

import { createApi, type StationApi } from '@/lib/api';
import { loadStationCredentials, loadStationPassword, loadStations } from '@/lib/station';

export interface IntentStation {
  base: string;
  /** Display name from recents, when the store has one. */
  name: string | null;
  api: StationApi;
}

export const NO_STATION_MESSAGE = 'Open SUB/WAVE and pick a station first.';

export async function activeStation(): Promise<IntentStation | null> {
  const store = await loadStations();
  const base = store.activeStation;
  if (!base) return null;
  const credentials = await loadStationCredentials(base).catch(() => null);
  const password = await loadStationPassword(base).catch(() => null);
  return {
    base,
    name: store.recents.find((r) => r.url === base)?.name ?? null,
    api: createApi(base, credentials, () => password),
  };
}
