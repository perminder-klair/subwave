// RNTP playback service. Runs in a headless JS context with no access to React
// state, so it only translates remote (lock-screen / headphone / car) events
// into TrackPlayer calls; the UI observes the same state through hooks.
//
// RemoteNext is deliberately not wired: on a shared live broadcast a stray
// AirPods double-tap must not skip the song for every listener. Seek is
// unwired too, since a live stream can't be scrubbed.
import TrackPlayer, { Event } from 'react-native-track-player';
import { getLastLiveMeta, loadAndPlay } from '@/audio/player';

export async function PlaybackService(): Promise<void> {
  // Pausing a live stream leaves a stale buffer, so a RemotePlay re-loads from
  // the last stream meta with a fresh cache-buster to reach the live edge. Any
  // failure falls back to a bare play() rather than going silent.
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
}
