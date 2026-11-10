import type { NowPlayingTrack } from './types';

/** startedAt is listener-time: useStationFeed has already added the buffer. */
export function trackElapsedSeconds(startedAt: number | null, now = Date.now()): number {
  return startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

export function nowPlayingProgress({
  track,
  trackStartedAt,
  talking,
  now = Date.now(),
}: {
  track: NowPlayingTrack | null;
  trackStartedAt: number | null;
  talking: boolean;
  now?: number;
}): { duration?: number; elapsedTime?: number } {
  const duration = track?.duration;
  if (talking || duration == null || !Number.isFinite(duration) || duration <= 0) return {};
  return {
    duration,
    ...(trackStartedAt == null
      ? {}
      : { elapsedTime: Math.min(duration, trackElapsedSeconds(trackStartedAt, now)) }),
  };
}
