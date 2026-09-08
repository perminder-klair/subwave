// Album cooldown policy on the agent path — pure, unit-pinned (#1485 FR 3).
// Enforced at the point of choice over the run's own candidates, since the
// discovery tools carry no album filter (#618).
//
// It is the SOFTEST guard in the sequence: no pool rescue ever, and a failed
// re-pick keeps the original pick — a preference must never cost the station a
// slot. Runs AFTER the artist guard, on whatever pick that left standing.

import { artistRootKey, type CandidateLike } from '../../music/recency.js';

// How a candidate's album key is resolved. Caller-supplied so every lookup
// stays at the call site; in production `music/album-facts.albumKeyFor`.
export type AlbumKeyOf<T> = (song: T) => string;

export interface AlbumAlternativePool<T> {
  /** The candidates a re-pick may choose from, keyed by id as `seen` is. */
  alt: Map<string, T>;
  /** How many fresh-album candidates the artist exclusion removed. */
  dropped: number;
  /** Every fresh-album alternative was also a neighbouring artist, so the
   *  artist exclusion was waived. `dropped` is 0 here too, so this is what
   *  tells "no-op" from "overruled". */
  starved: boolean;
}

// The candidate set for an album re-pick. `recentAlbums` already contains the
// rejected pick's own album. An empty albumKey (untitled, untagged, exempt
// compilation) is never dropped: absence of a name is not evidence of a repeat.
//
// `avoidArtistRoots` is the artist guard's window, so an album re-pick can't
// hand back the artist that guard just stepped around. It is a preference: when
// every fresh-album alternative is a neighbouring artist the unnarrowed set
// comes back (`starved`) rather than emptying the pool.
export function alternativeAlbumCandidates<T extends CandidateLike>(
  seen: Iterable<[string, T]>,
  recentAlbums: Set<string>,
  albumKeyOf: AlbumKeyOf<T>,
  avoidArtistRoots: Set<string> = new Set(),
): AlbumAlternativePool<T> {
  const base = [...seen].filter(([, s]) => {
    const key = albumKeyOf(s);
    return !key || !recentAlbums.has(key);
  });
  if (!base.length || !avoidArtistRoots.size) {
    return { alt: new Map(base), dropped: 0, starved: false };
  }

  const fresh = base.filter(([, s]) => {
    const root = artistRootKey(s);
    return !root || !avoidArtistRoots.has(root);
  });
  if (!fresh.length) return { alt: new Map(base), dropped: 0, starved: true };

  return { alt: new Map(fresh), dropped: base.length - fresh.length, starved: false };
}

export type AlbumGuardOutcome<T> =
  // The pick's album is fresh, exempt or untitled.
  | { kind: 'none' }
  // Fired, and the pick stands anyway.
  | { kind: 'kept' }
  // Fired and the re-pick landed: use these in place of the original pick.
  | { kind: 'repicked'; object: { id?: string | null } & Record<string, unknown>; song: T };

// Everything injected — no queue, no settings, no model — so the "never spends
// more than one re-pick" guarantee is an assertion counting injected calls.
export interface AlbumGuardDeps<T> {
  song: T;
  object: { id?: string | null } & Record<string, unknown>;
  /** The run's own candidates, keyed by id, as pickViaAgent's `extras.seen`. */
  seen: Iterable<[string, T]>;
  /** queue.recentAlbumKeys(hours) — the caller owns every queue read. */
  recentAlbums: Set<string>;
  /** queue.neighbourArtistRoots(window). */
  avoidArtistRoots: Set<string>;
  albumKeyOf: AlbumKeyOf<T>;
  /** settings.picker.albumHours, carried only for the log text. */
  hours: number;
  repick: (
    alt: Map<string, T>,
    reason: string,
  ) => Promise<({ id?: string | null } & Record<string, unknown>) | null>;
  log: (line: string) => void;
  logEvent: (name: string, payload: Record<string, unknown>) => void;
}

export async function runAlbumGuard<T extends CandidateLike>(
  deps: AlbumGuardDeps<T>,
): Promise<AlbumGuardOutcome<T>> {
  const { song, seen, recentAlbums, avoidArtistRoots, albumKeyOf, hours, repick, log, logEvent } = deps;

  const key = albumKeyOf(song);
  // '' covers exemptions and the untagged: a compilation keys as nothing on
  // BOTH sides, so it neither blocks nor is blocked.
  if (!key || !recentAlbums.has(key)) return { kind: 'none' };

  const { alt, dropped, starved } = alternativeAlbumCandidates<T>(
    seen, recentAlbums, albumKeyOf, avoidArtistRoots,
  );

  if (!alt.size) {
    logEvent('pick.albumGuard', {
      relaxed: true, reason: 'no-other-album', album: song.album, artist: song.artist, hours,
    });
    log(`recently-played album "${song.album}" allowed — every candidate in the run came off it (album cooldown ${hours}h)`);
    return { kind: 'kept' };
  }

  const repicked = await repick(
    alt,
    `The track you chose is from ${song.album}, a record already played in the last few hours — don't return to the same album that soon. Choose a track from a DIFFERENT album among the candidates above.`,
  );
  // Resolved out of `alt`, not the full `seen`, so the re-pick can only land
  // on something it was offered.
  const altSong = repicked?.id ? alt.get(repicked.id) : null;
  if (altSong && repicked) {
    logEvent('pick.albumGuard', {
      relaxed: false, from: song.album, to: altSong.album,
      candidates: alt.size, artistSkipped: dropped, artistStarved: starved, hours,
    });
    log(`recently-played album "${song.album}" avoided — re-picked "${altSong.title}" by ${altSong.artist} from ${alt.size} other-album candidate(s)${dropped ? `, ${dropped} more skipped as recently-played artists` : ''}${starved ? ' (every alternative was a recent artist — artist exclusion waived)' : ''}`);
    return { kind: 'repicked', object: repicked, song: altSong };
  }

  // The model declined the alternative. No second call for a preference: the
  // original pick stands, logged so a repeat is never silent.
  logEvent('pick.albumGuard', {
    relaxed: true, reason: 'repick-failed',
    album: song.album, artist: song.artist, candidates: alt.size, hours,
  });
  log(`recently-played album "${song.album}" allowed — re-pick from ${alt.size} other-album candidate(s) didn't land (album cooldown ${hours}h)`);
  return { kind: 'kept' };
}
