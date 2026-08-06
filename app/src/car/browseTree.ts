// The car-screen station list, as data.
//
// Android Auto shows what our react-native-track-player fork's Media3
// MediaLibraryService serves from the browse tree set via
// TrackPlayer.setBrowseTree; CarPlay renders the same list through
// CPListTemplate (src/car/carPlay.ts). Both are VIEWS over the existing
// station store (featured + recents) — no car-specific state exists. Selecting
// an item lands in service.ts as Event.RemotePlayId with the mediaId minted
// here, so mediaId minting and resolving must stay in this one module.
//
// Tree shape: one browsable "Stations" tab at the root (root-level browsable
// items render as tabs in Android Auto), containing one playable row per
// station. A station row is `playable: '0'` — the fork encodes playable-ness
// as MediaItemPlayable ('1' = browsable folder, anything else = playable leaf).

import { Platform } from 'react-native';
import TrackPlayer, {
  type AndroidAutoBrowseTree,
  type MediaItem,
} from 'react-native-track-player';
import { normalizeBase } from '@/lib/api';
import { featuredStation, loadStations, type StationRef } from '@/lib/station';

const STATION_MEDIA_ID_PREFIX = 'station:';
const STATIONS_TAB_ID = 'stations';

/** The car station list: featured first, then recents (deduped against the
 *  featured entry — it's usually also in recents once used). */
export function carStations(featured: StationRef, recents: StationRef[]): StationRef[] {
  const featuredUrl = normalizeBase(featured.url);
  return [
    featured,
    ...recents.filter((r) => normalizeBase(r.url) !== featuredUrl),
  ];
}

export function stationMediaId(ref: StationRef): string {
  return `${STATION_MEDIA_ID_PREFIX}${normalizeBase(ref.url)}`;
}

export function stationForMediaId(
  mediaId: string,
  stations: StationRef[],
): StationRef | null {
  if (!mediaId.startsWith(STATION_MEDIA_ID_PREFIX)) return null;
  const url = mediaId.slice(STATION_MEDIA_ID_PREFIX.length);
  return stations.find((s) => normalizeBase(s.url) === url) ?? null;
}

/** Credential-free host for the row subtitle ("radio.example.com"). */
export function displayHost(url: string): string {
  return normalizeBase(url)
    .replace(/^https?:\/\//i, '')
    .replace(/^[^/@]+@/, '')
    .replace(/[/?#].*$/, '');
}

export function carBrowseTree(stations: StationRef[]): AndroidAutoBrowseTree {
  const rows: MediaItem[] = stations.map((s) => ({
    mediaId: stationMediaId(s),
    title: s.name || displayHost(s.url),
    subtitle: displayHost(s.url),
    playable: '0',
  }));
  return {
    '/': [{ mediaId: STATIONS_TAB_ID, title: 'Stations', playable: '1' }],
    [STATIONS_TAB_ID]: rows,
  };
}

/** Push the current station list to the car. Callable from the React tree
 *  (StationContext, with the live store) or the headless playback service
 *  (no args — reads persisted storage, covering the car-cold-start case where
 *  the phone UI never mounts). Android-only: CarPlay gets its list through
 *  src/car/carPlay.ts instead. */
export async function publishCarBrowseTree(
  featured?: StationRef,
  recents?: StationRef[],
): Promise<void> {
  if (Platform.OS !== 'android') return;
  let f = featured;
  let r = recents;
  if (!f || !r) {
    f = f ?? featuredStation();
    r = r ?? (await loadStations()).recents;
  }
  try {
    await TrackPlayer.setBrowseTree(carBrowseTree(carStations(f, r)));
  } catch {
    /* player not set up yet — the next publish (setup follows shortly in
       every path that cares) supplies the tree */
  }
}
