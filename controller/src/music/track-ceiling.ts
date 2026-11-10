// Hard selection ceiling. Unlike the floor, this never restores prohibited
// tracks to avoid starvation; unknown metadata passes and equality is eligible.
import { trackLengthSeconds, type LengthTrack } from './track-floor.js';

export function aboveTrackCeiling(track: LengthTrack | null | undefined, maxSec: number | null | undefined): boolean {
  if (!maxSec || maxSec <= 0) return false;
  const duration = trackLengthSeconds(track);
  return duration != null && duration > maxSec;
}
