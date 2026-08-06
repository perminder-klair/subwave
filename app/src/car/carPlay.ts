// CarPlay UI: a "Stations" list → tap → tune → Now Playing.
//
// Template-only by design (Apple's CarPlay audio rules): the root is a
// CPListTemplate built from the same station list Android Auto shows
// (carStations), a row select runs the shared carTuneTo path, and the pushed
// NowPlayingTemplate is the SYSTEM now-playing screen — it renders whatever
// react-native-track-player already feeds MPNowPlayingInfoCenter
// (useNowPlayingInfo's title/artist/artwork), so there is no CarPlay-specific
// metadata plumbing here.
//
// The native side only exists once plugins/withCarPlay.js has injected the
// scene delegates and app.json carries the carplay-audio entitlement; on a
// build without them (and on Android, where react-native.config.js nulls the
// package out) this module must never touch the native module — hence the
// Platform gate + lazy import.

import { Platform } from 'react-native';
import { featuredStation, loadStations, type StationRef } from '@/lib/station';
import { carStations, displayHost } from './browseTree';
import { carTuneTo, onCarStationChange } from './carTune';

type RNCarPlay = typeof import('react-native-carplay');
type ListSections = { items: { text: string; detailText?: string }[] }[];

let started = false;

/** Idempotent; called once from index.ts, right after the playback service is
 *  registered (the car can connect before any UI mounts). */
export function startCarPlay(): void {
  if (started || Platform.OS !== 'ios') return;
  started = true;
  import('react-native-carplay')
    .then(setup)
    .catch(() => {
      started = false;
    });
}

function setup({ CarPlay, ListTemplate, NowPlayingTemplate }: RNCarPlay): void {
  let list: InstanceType<RNCarPlay['ListTemplate']> | null = null;
  let nowPlaying: InstanceType<RNCarPlay['NowPlayingTemplate']> | null = null;
  let stations: StationRef[] = [];

  const sectionsFor = (s: StationRef[]): ListSections => [
    {
      items: s.map((ref) => ({
        text: ref.name || displayHost(ref.url),
        detailText: displayHost(ref.url),
      })),
    },
  ];

  const currentStations = async (): Promise<StationRef[]> => {
    const store = await loadStations();
    return carStations(featuredStation(), store.recents);
  };

  CarPlay.registerOnConnect(() => {
    void (async () => {
      stations = await currentStations();
      nowPlaying = new NowPlayingTemplate({});
      list = new ListTemplate({
        title: 'Stations',
        sections: sectionsFor(stations),
        onItemSelect: async ({ index }) => {
          const ref = stations[index];
          if (!ref) return;
          try {
            await carTuneTo(ref);
            if (nowPlaying) CarPlay.pushTemplate(nowPlaying, true);
          } catch {
            /* stream failed to start — stay on the list so the driver can
               retry; the phone UI carries the diagnostic */
          }
        },
      });
      CarPlay.setRootTemplate(list);
    })();
  });

  CarPlay.registerOnDisconnect(() => {
    list = null;
    nowPlaying = null;
  });

  // Stations added/removed on the phone while the car is connected.
  onCarStationChange(() => {
    if (!CarPlay.connected || !list) return;
    void currentStations().then((s) => {
      stations = s;
      list?.updateSections(sectionsFor(s));
    });
  });
}
