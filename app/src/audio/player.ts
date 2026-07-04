// react-native-track-player setup + low-level controls for a LIVE stream.
//
// The stream is one endless MP3 whose metadata changes every song. We model it
// as a single Track with `isLiveStream: true` (hides the scrubber) and DO NOT
// rely on RNTP's position — displayed elapsed comes from the derived timer in
// useStationFeed (the same model the web uses). Lock-screen metadata is pushed
// from /now-playing polls via updateNowPlayingMetadata (see useNowPlayingInfo).

import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  RatingType,
} from 'react-native-track-player';

const STREAM_TRACK_ID = 'subwave-live';

let setupPromise: Promise<void> | null = null;

/** Idempotent player setup — safe to call from every mount. */
export function setupPlayer(): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      await TrackPlayer.setupPlayer({
        // A live stream needs a small buffer; keep defaults otherwise.
        autoHandleInterruptions: true,
      });
    } catch (e) {
      // "player already initialized" throws on fast refresh — benign.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already been initialized|already initialized/i.test(msg)) {
        setupPromise = null;
        throw e;
      }
    }
    await TrackPlayer.updateOptions({
      // RemoteNext is deliberately omitted (shared live broadcast — no per-
      // listener skip). Seek is omitted (can't scrub live).
      capabilities: [Capability.Play, Capability.Pause, Capability.Stop],
      compactCapabilities: [Capability.Play, Capability.Pause],
      notificationCapabilities: [Capability.Play, Capability.Pause, Capability.Stop],
      ratingType: RatingType.Heart,
      android: {
        appKilledPlaybackBehavior:
          AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
    });
  })();
  return setupPromise;
}

export interface LiveTrackMeta {
  url: string;
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  // HTTP headers for the stream request — carries `Authorization: Basic …` when
  // the station uses URL-embedded basic auth. RNTP maps these onto the iOS
  // AVURLAsset (AVURLAssetHTTPHeaderFieldsKey) and the Android DataSource, the
  // only auth path AVPlayer honours (it ignores userinfo in the URL — #764).
  headers?: Record<string, string>;
}

// The last stream meta we loaded, remembered so the headless playback service
// (service.ts) can re-load at the live edge on a lock-screen RemotePlay rather
// than resuming the stale paused buffer. Module-level because the service runs
// in a separate JS context from the React tree with no access to hook state.
let lastLiveMeta: LiveTrackMeta | null = null;

/** The meta of the currently-loaded live stream, or null when torn down. */
export function getLastLiveMeta(): LiveTrackMeta | null {
  return lastLiveMeta;
}

/** Load (or reload) the live stream onto the queue and start it. A cache-buster
 *  is appended so a reconnect doesn't replay a dead buffered segment (mirrors
 *  the web watchdog's `?t=`). */
export async function loadAndPlay(meta: LiveTrackMeta): Promise<void> {
  await setupPlayer();
  await TrackPlayer.reset();
  const bust = `${meta.url}${meta.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  await TrackPlayer.add({
    id: STREAM_TRACK_ID,
    url: bust,
    title: meta.title || 'SUB/WAVE',
    artist: meta.artist || 'Live broadcast',
    album: meta.album || 'SUB/WAVE',
    artwork: meta.artwork,
    isLiveStream: true,
    headers: meta.headers,
  });
  lastLiveMeta = meta;
  await TrackPlayer.play();
}

export async function teardown(): Promise<void> {
  lastLiveMeta = null;
  try {
    await TrackPlayer.reset();
  } catch {
    /* not set up yet */
  }
}
