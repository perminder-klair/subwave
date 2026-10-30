// This headless service cannot access React state.
// Skip and seek are unavailable on a shared live broadcast.
import TrackPlayer, { Event } from 'react-native-track-player';
import { getLastLiveMeta, loadAndPlay } from '@/audio/player';
import { tuneIn, tuneInByName } from '@/intents/tune';

export async function PlaybackService(): Promise<void> {
  // RemotePlay reloads with a cache-buster to discard the paused buffer.
  // If reloading fails, fall back to play.
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

  // Android Auto: a station picked from the car's list (its id is the
  // station's base), or asked for by voice. The tune-in Siri uses.
  TrackPlayer.addEventListener(Event.RemotePlayId, ({ id }) => {
    tuneIn(id).catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemotePlaySearch, ({ query }) => {
    tuneInByName(query).catch(() => {});
  });

  // Never settle. On Android this is a headless JS task, and RN fires JS timers
  // behind a paused activity only while one is running — the feed poll that
  // keeps lock-screen and Bluetooth metadata current among them. RN 0.85 never
  // delivered the finish signal; 0.86 does, so returning here stopped every
  // timer the moment the screen locked.
  await new Promise<never>(() => {});
}
