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
  type PlayerOptions,
  RatingType,
} from 'react-native-track-player';
import { executeOwnedLoadAndPlay } from '@/lib/audioFormatCoordinator';

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
        // Do NOT set minBuffer here. Any non-zero preferredForwardBufferDuration
        // on this infinite live stream silences AVPlayer entirely — its
        // "safe to play" heuristic never satisfies on a duration-∞ item no
        // matter how much data is buffered (4s behaved identically to 12s,
        // with the station's ~11s Icecast burst fully available). Verified on
        // device via the route-change/event trail, 2026-07-09.
        // The long-form-audio route-sharing policy (what Apple Music/Podcasts
        // use): iOS remembers the listener's chosen AirPlay device for this
        // app and keeps routing to it through audio-session churn. Without
        // it, the stream hiccup at an AirPlay handoff — plus the player
        // re-asserting its session under the DEFAULT policy (SwiftAudioEx
        // even recreates the whole AVPlayer on item failure) — yanked audio
        // back to the built-in speaker ~2s after picking a HomePod.
        iosCategoryPolicy: 'longFormAudio',
      };
      await TrackPlayer.setupPlayer(options);
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

/** Load (or reload) the live stream and start it. A cache-buster is appended
 *  so a reconnect doesn't replay a dead buffered segment (mirrors the web
 *  watchdog's `?t=`).
 *
 *  Uses `load()` (in-place item swap), NOT `reset()`+`add()`: reset tears the
 *  player down and deactivates the iOS audio session, and a deactivated
 *  session reverts an active AirPlay route to the built-in speaker — the
 *  watchdog's quick retry after the route-change hiccup was knocking
 *  listeners off their HomePod ~2s after they picked it. `load()` keeps the
 *  session — and the listener's chosen output — alive (it also loads-as-first
 *  when the queue is empty, so fresh tune-ins take the same path). */
export async function loadAndPlay(
  meta: LiveTrackMeta,
  isOwned: () => boolean = () => true,
): Promise<void> {
  await executeOwnedLoadAndPlay(meta, isOwned, {
    setup: setupPlayer,
    load: async (next) => {
      const bust = `${next.url}${next.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
      await TrackPlayer.load({
        id: STREAM_TRACK_ID,
        url: bust,
        title: next.title || 'SUB/WAVE',
        artist: next.artist || 'Live broadcast',
        album: next.album || 'SUB/WAVE',
        artwork: next.artwork,
        isLiveStream: true,
        headers: next.headers,
      });
    },
    play: () => TrackPlayer.play(),
    reset: () => TrackPlayer.reset(),
    setMeta: (next) => { lastLiveMeta = next; },
  });
}

export async function teardown(): Promise<void> {
  lastLiveMeta = null;
  try {
    await TrackPlayer.reset();
  } catch {
    /* not set up yet */
  }
}
