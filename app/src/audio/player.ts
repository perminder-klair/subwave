// RNTP setup and low-level controls for a live stream: one endless Track with
// `isLiveStream: true` (hides the scrubber). RNTP's position is not used;
// displayed elapsed comes from useStationFeed's derived timer, and lock-screen
// metadata is pushed from /now-playing polls by useNowPlayingInfo.

import { Platform } from 'react-native';
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  type PlayerOptions,
  RatingType,
} from 'react-native-track-player';

const STREAM_TRACK_ID = 'subwave-live';

let setupPromise: Promise<void> | null = null;

/** Idempotent player setup — safe to call from every mount. */
export function setupPlayer(): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      // iosCategoryPolicy is read by the native module (SessionCategories.swift)
      // but missing from the lib's PlayerOptions type — extend it locally.
      const options: PlayerOptions & { iosCategoryPolicy?: 'longFormAudio' } = {
        autoHandleInterruptions: true,
        // Deep buffering is ANDROID-ONLY; never set these unconditionally. On
        // iOS minBuffer maps to preferredForwardBufferDuration, and any
        // non-zero value silences AVPlayer on this infinite stream. On Android
        // they map to ExoPlayer's LoadControl so a dead zone drains the buffer
        // instead of stalling (#993); playBuffer stays small for instant
        // tune-in.
        ...(Platform.OS === 'android'
          ? { minBuffer: 60, maxBuffer: 120, playBuffer: 2, backBuffer: 0 }
          : {}),
        // iOS remembers the chosen AirPlay device for this app and keeps
        // routing to it through audio-session churn. Under the default policy
        // a handoff yanks audio back to the built-in speaker.
        iosCategoryPolicy: 'longFormAudio',
      };
      await TrackPlayer.setupPlayer(options);
    } catch (e) {
      // "player already initialized" throws on fast refresh; benign.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already been initialized|already initialized/i.test(msg)) {
        setupPromise = null;
        throw e;
      }
    }
    await TrackPlayer.updateOptions({
      // No RemoteNext (shared live broadcast, no per-listener skip) and no
      // Seek (can't scrub live).
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
  // Carries `Authorization: Basic …` for a station with basic auth. RNTP maps
  // these onto AVURLAsset and the Android DataSource; it is the only auth path
  // AVPlayer honours, since it ignores URL userinfo (#764).
  headers?: Record<string, string>;
}

// Last loaded stream meta, so service.ts can re-load at the live edge on a
// lock-screen RemotePlay instead of resuming a stale buffer. Module-level
// because that service runs outside the React tree.
let lastLiveMeta: LiveTrackMeta | null = null;

/** The meta of the currently-loaded live stream, or null when torn down. */
export function getLastLiveMeta(): LiveTrackMeta | null {
  return lastLiveMeta;
}

/** Load (or reload) the live stream and start it. The cache-buster stops a
 *  reconnect replaying a dead buffered segment.
 *
 *  Must use `load()` (in-place swap), not `reset()`+`add()`: reset deactivates
 *  the iOS audio session, which reverts an active AirPlay route to the
 *  built-in speaker. `load()` also loads-as-first on an empty queue, so fresh
 *  tune-ins take the same path. */
export async function loadAndPlay(meta: LiveTrackMeta): Promise<void> {
  await setupPlayer();
  const bust = `${meta.url}${meta.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  await TrackPlayer.load({
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
