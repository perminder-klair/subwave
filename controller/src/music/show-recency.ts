// No-repeat capacity for scheduled shows: the hard window clamped to the universe
// a pick may draw from. One module so the agent and pool paths share one policy.

import { effectiveNoRepeatWindow, exhaustiveNoRepeatWindow, trackKey } from './recency.js';
import { applyStrictLocks, type FilterTrack, type VocalMode, type YearRange } from './show-filter.js';
import { applyKnownTrackCeiling } from './track-duration.js';
import { applyTrackFloor, trackLengthSeconds } from './track-floor.js';

type ShowTrack = FilterTrack & {
  id?: string;
  title?: string | null;
  artist?: string | null;
  duration?: number | null;
  durationSec?: number | null;
};

type RecencyShow = {
  playlistStrict?: boolean;
  playlistExhaust?: boolean;
  filtersStrict?: boolean;
  genres?: string[];
  eras?: YearRange[];
  moods?: string[];
  energies?: string[];
  vocals?: string;
} | null;

export type ShowNoRepeatGuard = {
  // Distinct plays the hard guard withholds, on top of the on-air track. Read
  // through hardRecentFor, never handed to the queue directly.
  window: number;
  // The show's own full-rotation window (#1612) rather than a clamped N. The pool
  // picker samples its show-playlist source differently when set; never re-derive.
  exhaustive: boolean;
  // The airable rotation itself, present exactly when `exhaustive` is. Its
  // window is measured over THIS set's own air history (hardRecentFor), never
  // the station's: other shows' plays must not push its tracks out (#1919).
  rotation?: ShowTrack[];
};

// When a track last went to air, epoch ms; null = never on record. Infinity =
// on air or queued: committed to air, so a rotation counts it as spent.
// queue.rotationAirTimes() is the live one.
export type AirTimeOf = (track: ShowTrack) => number | null;

// The two histories a pick's hard no-repeat set can be measured over. The queue
// satisfies it; a stub in a test does too.
export interface NoRepeatHistory {
  recentlyPlayedByCount(n: number): { ids: Set<string>; keys: Set<string> };
  rotationAirTimes(): AirTimeOf;
}

// Floor on the strict-playlist coast (#1919): never write a fallback shorter
// than an hour of audio. With llm.pauseWhenEmpty the DJ stops picking while
// nobody listens and auto.m3u IS the programme until the next rebuild, which
// the refresh cron runs at most an hour apart — a 2-track file is a 2-track
// loop for that hour. (A stream idle pause freezes the music instead, so
// nothing coasts through it.)
export const COAST_MIN_SEC = 3600;

// What of a strict anchor can actually AIR: the show's strict locks (never-
// starve, as the pool picker applies them), the known length ceiling, the
// minimum-length floor, and the excluded playlists. ORDER-PRESERVING — every
// step is a filter — so the in-order walk (music/playlist-order.ts) walks the
// same set this guard counts. Two copies of "can this anchor track air" is how
// the rotation size and the running order would come to disagree.
export function airableAnchorTracks<T extends ShowTrack>(
  playlistTracks: T[],
  {
    show,
    excludedIds,
    resolvedGenres,
    minTrackSec,
    maxTrackSec,
  }: {
    show: RecencyShow;
    excludedIds: Set<string> | null;
    resolvedGenres?: string[];
    minTrackSec?: number | null;
    maxTrackSec?: number | null;
  },
): T[] {
  const filtered = show?.filtersStrict
    ? applyStrictLocks(playlistTracks, {
        genres: resolvedGenres ?? show.genres ?? [],
        eras: show.eras ?? [],
        moods: show.moods ?? [],
        energies: show.energies ?? [],
        vocals: (show.vocals === 'instrumental' || show.vocals === 'vocal'
          ? show.vocals
          : '') as VocalMode,
      }, { starve: false })
    : playlistTracks;
  // Hard, unlike the pool picker's never-starve use of the same floor: what can
  // air, not a pool that must not empty. Nothing left = nothing airable.
  const airable = applyTrackFloor(applyKnownTrackCeiling(filtered, maxTrackSec), minTrackSec ?? null, { starve: true });
  return airable.filter(track => !!track?.id && !excludedIds?.has(track.id));
}

// The whole library a STRICT-filter show may draw from: the indexed library's
// lock projection (library.candidateFilterTracks()) through the same airable
// rule as a strict anchor — never-starve locks, length ceiling and floor,
// excluded playlists. Null when the show is not strict, so a caller can pass
// the result straight to showNoRepeatGuard and the small-pool picker tool.
//
// Without it a strict show's hard window was sized from the WHOLE library: a
// 290-play window against a 49-track show withheld every eligible track within
// a few hours, every discovery source came back empty, and each pick fell to
// the fallback pool. A strict playlist was already clamped to its own size; a
// strict filter is the same kind of closed catalogue.
export function strictShowLibraryPool<T extends ShowTrack>(
  libraryTracks: T[] | null | undefined,
  opts: {
    show: RecencyShow;
    excludedIds: Set<string> | null;
    resolvedGenres?: string[];
    minTrackSec?: number | null;
    maxTrackSec?: number | null;
  },
): T[] | null {
  if (!opts.show?.filtersStrict || !libraryTracks) return null;
  return airableAnchorTracks(libraryTracks, opts);
}

export function showNoRepeatGuard(
  configuredN: number | null | undefined,
  libraryTotal: number | null | undefined,
  {
    show,
    playlistTracks,
    episodeTracks = null,
    excludedIds,
    resolvedGenres,
    minTrackSec,
    maxTrackSec,
    showLibraryPool = null,
  }: {
    show: RecencyShow;
    playlistTracks: ShowTrack[] | null;
    episodeTracks?: ShowTrack[] | null;
    excludedIds: Set<string> | null;
    // Free-text show genres already resolved onto library tags, so capacity and
    // eligibility agree.
    resolvedGenres?: string[];
    // settings.effectiveMinTrackSec (#1573). Counted HARD: a track that will
    // never air must not size the window.
    minTrackSec?: number | null;
    maxTrackSec?: number | null;
    // strictShowLibraryPool's answer for this show; null/absent keeps the
    // library-wide window.
    showLibraryPool?: ShowTrack[] | null;
  },
): ShowNoRepeatGuard {
  if (episodeTracks) {
    const identities = new Set(episodeTracks.map(track => track.title ? `key:${trackKey(track)}` : `id:${track.id}`));
    return { window: effectiveNoRepeatWindow(configuredN, identities.size), exhaustive: false };
  }
  // A soft anchor can leave the playlist, and an unresolved strict anchor has
  // no playlist lock at runtime. Both still need the library-wide window.
  if (!show?.playlistStrict || playlistTracks == null) {
    // A strict-filter show cannot leave its filters, whatever its playlist
    // posture, so its own pool is the catalogue the window must fit.
    if (showLibraryPool) {
      return { window: effectiveNoRepeatWindow(configuredN, identityCount(showLibraryPool)), exhaustive: false };
    }
    return { window: effectiveNoRepeatWindow(configuredN, libraryTotal), exhaustive: false };
  }

  const airable = airableAnchorTracks(playlistTracks, { show, excludedIds, resolvedGenres, minTrackSec, maxTrackSec });

  const identities = { size: identityCount(airable) };

  // Full rotation (#1612): window is the rotation's own size, recomputed per pick.
  // `=== true`, not truthy, matching showBool()'s reading of the saved shape.
  if (show.playlistExhaust === true) {
    // Too small to carry its own window yields 0 and must NOT fall back to the
    // configured window; off means off and the relaxable cascade takes it.
    const window = exhaustiveNoRepeatWindow(identities.size);
    return window > 0 ? { window, exhaustive: true, rotation: airable } : { window, exhaustive: false };
  }

  return { window: effectiveNoRepeatWindow(configuredN, identities.size), exhaustive: false };
}

// The hard no-repeat set a pick runs under. One function so the agent and pool
// paths cannot disagree about WHOSE history a window is counted over: a full
// rotation over its own tracks' airings, everything else over the station's
// last N distinct plays, as before.
//
// Station-wide was the #1919 bug: a 5-hour show the night before filled a
// 107-play window with its own tracks, so playlist tracks heard just before the
// break came round again while others had not aired at all.
export function hardRecentFor(guard: ShowNoRepeatGuard, history: NoRepeatHistory): { ids: Set<string>; keys: Set<string> } {
  return guard.rotation
    ? rotationHardSet(guard.rotation, history.rotationAirTimes(), guard.window)
    : history.recentlyPlayedByCount(guard.window);
}

// The rotation's `window + 1` most recently aired identities — the +1 is the
// slot queue.recentlyPlayedByCount always spent on the on-air track, which the
// air-time reader now stamps Infinity along with everything queued. With the
// S-2 window that withholds S-1 and leaves exactly the identity that has waited
// longest (or every one never aired), so the hard set IS the longest-waiting-
// first rule. Plays of tracks outside the rotation never count: only this set's
// own history moves it.
export function rotationHardSet(
  rotation: ShowTrack[],
  airTimeOf: AirTimeOf,
  window: number,
): { ids: Set<string>; keys: Set<string> } {
  const ids = new Set<string>();
  const keys = new Set<string>();
  if (!Number.isFinite(window) || window <= 0) return { ids, keys };
  const aired = rotationIdentities(rotation, airTimeOf)
    .filter(identity => identity.at != null)
    // Equal stamps compare as equal: Infinity - Infinity is NaN.
    .sort((a, b) => (a.at === b.at ? 0 : (b.at as number) - (a.at as number)));
  for (const identity of aired.slice(0, window + 1)) {
    for (const track of identity.tracks) {
      if (track.id) ids.add(track.id);
      if (track.title) keys.add(trackKey(track));
    }
  }
  return { ids, keys };
}

// Longest-waiting first: never aired, then oldest air, with on-air and queued
// tracks last. Stable, so a caller that shuffles first breaks ties at random.
export function rotationOrder<T extends ShowTrack>(tracks: T[], airTimeOf: AirTimeOf): T[] {
  const rank = (at: number | null) => (at == null ? -Infinity : at);
  return tracks
    .map((track, i) => ({ track, i, at: rank(airTimeOf(track)) }))
    .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at - b.at))
    .map(entry => entry.track);
}

// The auto.m3u coast for a full rotation (#1919): the tracks next due, not a
// recency-filtered sample. The station-wide trackHours window cut a 109-track
// rotation to 2-5 tracks that Liquidsoap then looped for an hour and more.
//
// Liquidsoap plays the file `mode="randomize"`, so the ORDER written is lost
// and only the SET carries the rotation. Hence the longest-waiting half at most
// (capped at `cap`, a strict playlist's usual share of the coast): any
// shuffle of the tracks most overdue stays inside the rotation's next stretch,
// and none of them is something the listener just heard. Then COAST_MIN_SEC
// tops it up, deeper into the rotation if it must, and never with what is on
// air or queued unless nothing else exists. One row per audible identity.
export function rotationCoast<T extends ShowTrack>(
  rotation: T[],
  airTimeOf: AirTimeOf,
  { cap, floorSec = COAST_MIN_SEC }: { cap: number; floorSec?: number },
): T[] {
  const identities = rotationIdentities(rotation, airTimeOf);
  // Read each identity's newest airing, not its first row's.
  const atOf = new Map<ShowTrack, number | null>(identities.map(identity => [identity.tracks[0], identity.at]));
  const identityAt: AirTimeOf = track => atOf.get(track) ?? null;
  const ordered = rotationOrder(identities.map(identity => identity.tracks[0]), identityAt);
  const due = Math.min(cap, Math.ceil(identities.length / 2));
  const head = ordered.filter(track => identityAt(track) !== Infinity).slice(0, due);
  return coastFloor(head, ordered, identityAt, floorSec);
}

// Never-collapse floor for any strict-playlist coast: top `pool` up from
// `ordered` (longest-waiting first) until it holds `floorSec` of audio. An
// unknown length counts as nothing — the failure direction is a longer file,
// never a shorter loop. On-air and queued tracks are the last resort, used only
// when the pool would otherwise be empty. Always a FRESH array: the coast
// rebuilds its pool in place, and a never-starve filter that hands its input
// back empties it (music.md).
export function coastFloor<T extends ShowTrack>(
  pool: T[],
  ordered: T[],
  airTimeOf: AirTimeOf,
  floorSec: number = COAST_MIN_SEC,
): T[] {
  const out = [...pool];
  const seen = new Set(out.map(identityOf));
  let sec = out.reduce((sum, track) => sum + (trackLengthSeconds(track) ?? 0), 0);
  const add = (track: T) => {
    const identity = identityOf(track);
    if (seen.has(identity)) return;
    seen.add(identity);
    out.push(track);
    sec += trackLengthSeconds(track) ?? 0;
  };
  for (const track of ordered) {
    if (sec >= floorSec) break;
    if (airTimeOf(track) !== Infinity) add(track);
  }
  if (!out.length) for (const track of ordered) add(track);
  return out;
}

type RotationIdentity<T extends ShowTrack> = { tracks: T[]; at: number | null };

// One entry per audible identity, its air time the newest of its rows — a
// duplicate rip shares its twin's history, as identityCount shares its slot.
function rotationIdentities<T extends ShowTrack>(tracks: T[], airTimeOf: AirTimeOf): RotationIdentity<T>[] {
  const byIdentity = new Map<string, RotationIdentity<T>>();
  for (const track of tracks) {
    if (!track?.id && !track?.title) continue;
    const key = identityOf(track);
    const at = airTimeOf(track);
    const entry = byIdentity.get(key);
    if (!entry) byIdentity.set(key, { tracks: [track], at });
    else {
      entry.tracks.push(track);
      if (at != null && (entry.at == null || at > entry.at)) entry.at = at;
    }
  }
  return [...byIdentity.values()];
}

function identityOf(track: ShowTrack): string {
  return track.title ? `key:${trackKey(track)}` : `id:${track.id}`;
}

// Count audible identities, not rows: duplicate rips with different ids consume
// one slot in the real rotation and must not inflate its capacity.
function identityCount(tracks: ShowTrack[]): number {
  return new Set(tracks.map(identityOf)).size;
}
