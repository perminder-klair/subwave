// RNTP position is not the displayed track clock; useStationFeed supplies it.

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
      // RNTP reads iosCategoryPolicy natively but omits it from PlayerOptions.
      const options: PlayerOptions & { iosCategoryPolicy?: 'longFormAudio' } = {
        autoHandleInterruptions: true,
        // Android LoadControl needs deep buffering for dropouts (#993).
        // iOS maps minBuffer to preferredForwardBufferDuration; a nonzero value silences this stream.
        ...(Platform.OS === 'android'
          ? { minBuffer: 60, maxBuffer: 120, playBuffer: 2, backBuffer: 0 }
          : {}),
        // longFormAudio preserves the selected AirPlay route across audio-session changes.
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

// Module state lets the headless RemotePlay handler reload at the live edge.
let lastLiveMeta: LiveTrackMeta | null = null;

export function getLastLiveMeta(): LiveTrackMeta | null {
  return lastLiveMeta;
}

/** The cache-buster discards stale buffered audio. Use load() to preserve
 *  the iOS AirPlay route; reset()+add() deactivates the audio session. */
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

// A tune-out that reaches the player from outside the React tree without an
// RNTP remote event: an App Intent (src/intents/tune.ts). usePlayer must hear
// it before the Stopped event lands, or it reads Stopped as a dead stream and
// reconnects, the same trap RemotePause is handled for.
const tuneOutListeners = new Set<() => void>();

export function onExternalTuneOut(fn: () => void): () => void {
  tuneOutListeners.add(fn);
  return () => {
    tuneOutListeners.delete(fn);
  };
}

/** stop(), not teardown(): the Icecast connection drops, and lastLiveMeta
 *  survives so the next tune-in resumes at the live edge. */
export async function externalTuneOut(): Promise<void> {
  tuneOutListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* a broken subscriber must not keep the stream running */
    }
  });
  await TrackPlayer.stop();
}

export async function teardown(): Promise<void> {
  lastLiveMeta = null;
  try {
    await TrackPlayer.reset();
  } catch {
    /* not set up yet */
  }
}
