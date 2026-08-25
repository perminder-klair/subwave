// Tune-in initiated from a car screen (Android Auto browse tap / voice search,
// CarPlay list row). Module-level — NOT a hook — because the callers live in
// the headless playback service (service.ts), which runs outside the React
// tree. The same JS VM hosts both, so module state is shared with the UI when
// it's mounted (the getLastLiveMeta pattern in audio/player.ts).
//
// Ordering contract with usePlayer's station-change effect: persist + notify
// FIRST, then start the new audio. If the phone UI is mounted and tuned to the
// old station, its base-change effect stops that stream; once our loadAndPlay
// lands, the loaded stream belongs to the new base, so the effect's
// streamBelongsTo guard adopts it instead of stopping it (and the Playing
// event re-adopts tunedIn via getLastLiveMeta — the same path a lock-screen
// resume takes).

import TrackPlayer, { State } from 'react-native-track-player';
import { getLastLiveMeta, loadAndPlay, teardown } from '@/audio/player';
import { createApi, normalizeBase, streamBelongsTo } from '@/lib/api';
import { setActiveStation, type StationRef } from '@/lib/station';
import { loadFormatPref, platformSupports } from '@/lib/streamFormat';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to car-initiated active-station changes (StationContext reloads
 *  its store off this so the phone UI follows the car). Returns unsubscribe. */
export function onCarStationChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notifyCarStationChange(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* a broken subscriber must not break car playback */
    }
  });
}

/** Switch to `ref` and start its stream. Safe from both the headless service
 *  and the React tree; a tap on the already-playing station is a no-op (a car
 *  row select must not restart a healthy stream). */
export async function carTuneTo(ref: StationRef): Promise<void> {
  const url = normalizeBase(ref.url);

  const meta = getLastLiveMeta();
  if (meta && streamBelongsTo(meta.url, url)) {
    const { state } = await TrackPlayer.getPlaybackState().catch(() => ({ state: State.None }));
    if (state === State.Playing || state === State.Buffering || state === State.Loading) {
      return;
    }
  }

  await setActiveStation({ url, name: ref.name });
  notifyCarStationChange();

  // Harmless double-teardown when the UI's base-change effect got there first;
  // load-bearing on a car cold start where no UI exists to do it.
  await teardown();

  const api = createApi(url);
  const pref = await loadFormatPref(api.base);
  const format = pref && platformSupports(pref) ? pref : 'mp3';
  await loadAndPlay({
    url: api.streamUrl(format),
    headers: api.streamHeaders(),
    title: ref.name || 'SUB/WAVE',
  });
}

/** Resolve a voice query ("play sub wave") to a station. Loose contains-match
 *  on the station name; anything unmatched falls back to the active station,
 *  then featured — for a one-station listener every phrasing of "play my
 *  radio" should just start the radio (car-app quality criterion VC-1 wants a
 *  best-effort result, not an error). */
export function matchStationQuery(
  query: string,
  stations: StationRef[],
  activeUrl: string | null,
): StationRef | null {
  const fallback =
    (activeUrl && stations.find((s) => normalizeBase(s.url) === normalizeBase(activeUrl))) ||
    stations[0] ||
    null;
  const q = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!q) return fallback;
  return (
    stations.find((s) => {
      const name = (s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      return name && (name.includes(q) || q.includes(name));
    }) ?? fallback
  );
}
