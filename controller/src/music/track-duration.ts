// Air-path adapter: use metadata already in memory/SQLite, never fetch media.
import * as library from './library.js';
import { trackLengthSeconds, type LengthTrack } from './track-floor.js';
import { aboveTrackCeiling } from './track-ceiling.js';

type DurationTrack = LengthTrack & { id?: string | null; duration_sec?: number | null };

export function knownTrackLengthSeconds(track: DurationTrack): number | null {
  return trackLengthSeconds(track)
    ?? trackLengthSeconds({ duration: track.duration_sec })
    ?? (track.id ? trackLengthSeconds(library.get(track.id)) : null);
}

export function aboveKnownTrackCeiling(track: DurationTrack, maxSec: number | null | undefined): boolean {
  return !!maxSec && aboveTrackCeiling({ duration: knownTrackLengthSeconds(track) }, maxSec);
}

export function applyKnownTrackCeiling<T extends DurationTrack>(tracks: T[], maxSec: number | null | undefined): T[] {
  return tracks.filter(track => !aboveKnownTrackCeiling(track, maxSec));
}
