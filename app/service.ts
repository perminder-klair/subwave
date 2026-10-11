// This headless service cannot access React state.
// Skip and seek are unavailable on a shared live broadcast.
import TrackPlayer, { Event } from 'react-native-track-player';
import { getLastLiveMeta, loadAndPlay } from '@/audio/player';

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
}
