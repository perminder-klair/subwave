// A clean show (show.excludeExplicit) keeps tracks tagged explicit off air. This
// module owns that decision for every path a show's music takes; nothing else
// reads the tag or the setting.
//
// Failure direction, deliberately open: only a track positively tagged
// 'explicit' is held back. 'clean', no tag and an unknown track all pass. Most
// files carry no advisory tag at all, so failing closed would empty a clean show
// on every ordinary library. The promise is "what your tags say", no more, and
// the show editor says so in those words.
//
// Where it runs relative to the never-starve steps: FIRST. A strict lock or a
// playlist anchor that finds nothing is skipped to keep the music going, so the
// filter has to come before them for those to be what gives way. The pick paths
// are then hard, like the excluded playlists: an empty result leaves the slot to
// the auto.m3u coast, and only the coast may give way, last of all and in the
// booth log (docs/internals/music.md → Clean shows).

import * as library from './library.js';
import { normaliseExplicitStatus, type ExplicitStatus } from './library-db.js';

// Library rows and raw Subsonic children both satisfy this structurally.
export interface ExplicitTrack {
  id?: string | null;
  explicitStatus?: unknown;
}

type CleanShowFlag = { excludeExplicit?: unknown } | null | undefined;

// `=== true`, matching showBool()'s reading of the saved shape. Off or absent
// is the whole of today's behaviour.
export function excludesExplicit(show: CleanShowFlag): boolean {
  return show?.excludeExplicit === true;
}

// A candidate that carries the field is judged on it, null and '' included: a
// library row knows its own column, and a raw child is the server's live answer.
// Undefined is a source that never reported it, so the library is asked, and a
// track with no row is unknown. So is one the library cannot answer for: this
// runs on the drain, and a failing read must not stop the music.
export function trackExplicitStatus(t: ExplicitTrack | null | undefined): ExplicitStatus | null {
  if (t?.explicitStatus !== undefined) return normaliseExplicitStatus(t.explicitStatus);
  try {
    return normaliseExplicitStatus(t?.id ? library.get(t.id)?.explicitStatus : null);
  } catch {
    return null;
  }
}

// Hard, even to empty. Always a fresh array, on or off: the coast rebuilds its
// pool in place, and a filter that hands its input back gets it cleared.
export function withoutExplicit<T extends ExplicitTrack>(tracks: readonly T[], exclude: boolean): T[] {
  if (!exclude) return tracks.slice();
  return tracks.filter(t => trackExplicitStatus(t) !== 'explicit');
}

// One whole pool build, for the two builders that assemble from many sources:
// the same hard filter, remembering what it dropped so the booth log can say a
// clean show is why a pool came up empty, and so the coast still has something
// to keep the station on air with.
export interface ExplicitGate<T> {
  on: boolean;
  pass(tracks: readonly T[]): T[];
  held(): T[];
}

export function explicitGate<T extends ExplicitTrack>(show: CleanShowFlag): ExplicitGate<T> {
  const on = excludesExplicit(show);
  const held = new Map<string, T>();
  return {
    on,
    pass(tracks) {
      if (!on) return tracks.slice();
      return tracks.filter((t) => {
        if (trackExplicitStatus(t) !== 'explicit') return true;
        if (t?.id) held.set(t.id, t);
        return false;
      });
    },
    held: () => [...held.values()],
  };
}

// One track against one show: a listener's ask, or an unsent automatic pick at
// the drain. Operator pushes never reach this: the studio routes go straight to
// queue.push(), which does not ask, and the drain leaves whatever was requested.
export function heldBackFromShow(track: ExplicitTrack | null | undefined, show: CleanShowFlag): boolean {
  return excludesExplicit(show) && trackExplicitStatus(track) === 'explicit';
}

// Whether any show is clean at all, so a station with none does no work.
export function anyCleanShow(shows: readonly CleanShowFlag[] | null | undefined): boolean {
  return Array.isArray(shows) && shows.some(excludesExplicit);
}
