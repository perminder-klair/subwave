// react-native-track-player playback service.
//
// This runs in a headless JS context the OS keeps alive for background audio,
// so it can ONLY react to remote (lock-screen / headphone / car) events — it
// has no access to React state. We translate remote controls into TrackPlayer
// calls. The UI observes the same TrackPlayer state via hooks, so everything
// stays consistent.
//
// RemoteNext is intentionally NOT wired: this is a shared live broadcast, so a
// stray AirPods double-tap must not skip the current song for every listener
// (mirrors the web player's deliberate omission). Seek is also unwired — you
// can't scrub a live stream.
import TrackPlayer, { Event } from 'react-native-track-player';
import { getLastLiveMeta, loadAndPlay } from '@/audio/player';
import { carStations, publishCarBrowseTree, stationForMediaId } from '@/car/browseTree';
import { carTuneTo, matchStationQuery } from '@/car/carTune';
import { featuredStation, loadStations } from '@/lib/station';

export async function PlaybackService(): Promise<void> {
  // Pausing a live stream leaves a stale buffer behind. On a lock-screen /
  // headphone RemotePlay we want the LIVE edge, not the dead buffered segment,
  // so re-load from the last stream meta with a fresh cache-buster (same move
  // the UI watchdog makes). Everything here is best-effort — this is a headless
  // context, so any failure falls back to a bare play() rather than going
  // silent. (Device QA validates this; see docs/QA-CHECKLIST.md.)
  TrackPlayer.addEventListener(Event.RemotePlay, async () => {
    try {
      const meta = getLastLiveMeta();
      if (meta) {
        await loadAndPlay(meta);
        return;
      }
    } catch {
      /* fall through to a plain resume */
    }
    TrackPlayer.play().catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());

  // --- Android Auto ---------------------------------------------------------
  // Browse-tree taps and voice queries land here (Media3 MediaLibraryService in
  // the RNTP fork → Event.RemotePlayId / RemotePlaySearch). Resolution goes
  // through the persisted station store, not React state — on a car cold start
  // this service is all that's running.
  TrackPlayer.addEventListener(Event.RemotePlayId, async ({ id }) => {
    try {
      const store = await loadStations();
      const ref = stationForMediaId(id, carStations(featuredStation(), store.recents));
      if (ref) await carTuneTo(ref);
    } catch {
      /* headless best-effort — the car shows the session's error state */
    }
  });
  TrackPlayer.addEventListener(Event.RemotePlaySearch, async ({ query }) => {
    try {
      const store = await loadStations();
      const ref = matchStationQuery(
        query ?? '',
        carStations(featuredStation(), store.recents),
        store.activeStation,
      );
      if (ref) await carTuneTo(ref);
    } catch {
      /* headless best-effort */
    }
  });

  // Publish the station list even when the phone UI never mounts (car cold
  // start). StationContext republishes with the live store on every change.
  publishCarBrowseTree().catch(() => {});
}
