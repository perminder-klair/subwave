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

export async function PlaybackService(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  // Pausing a live stream leaves a stale buffer; when the user resumes from the
  // lock screen we want the live edge, so treat a duck-end / pause the same way
  // the watchdog does in usePlayer — handled UI-side via reset+play.
}
