// Apply album cooldown after the artist guard. A failed re-pick retains the original; this
// preference never triggers pool rescue or loses a slot. #1485 FR 3, #618.

import { artistCreditsOverlap, artistRootKey, creditInRoots, type CandidateLike } from '../../music/recency.js';

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
  /** How many fresh-album candidates the anchor exclusion removed. With `alt`
   *  empty, this is what tells "the run was all one record" from "the only
   *  other records were by the pick-anchor artist". */
  anchorSkipped: number;
}

// Album re-picks preserve unknown/exempt album keys. Narrow by the artist guard's window,
// restoring fresh-album alternatives on starvation without undoing an avoided anchor.
export function alternativeAlbumCandidates<T extends CandidateLike>(
  seen: Iterable<[string, T]>,
  recentAlbums: Set<string>,
  albumKeyOf: AlbumKeyOf<T>,
  avoidArtistRoots: Set<string> = new Set(),
  avoidAnchorRoot = '',
): AlbumAlternativePool<T> {
  const otherAlbum = [...seen].filter(([, s]) => {
    const key = albumKeyOf(s);
    return !key || !recentAlbums.has(key);
  });
  const base = otherAlbum.filter(([, s]) => !artistCreditsOverlap(artistRootKey(s), avoidAnchorRoot));
  const anchorSkipped = otherAlbum.length - base.length;
  if (!base.length || !avoidArtistRoots.size) {
    return { alt: new Map(base), dropped: 0, starved: false, anchorSkipped };
  }

  const fresh = base.filter(([, s]) => {
    const root = artistRootKey(s);
    return !root || !creditInRoots(s, avoidArtistRoots);
  });
  if (!fresh.length) return { alt: new Map(base), dropped: 0, starved: true, anchorSkipped };

  return { alt: new Map(fresh), dropped: base.length - fresh.length, starved: false, anchorSkipped };
}

export type AlbumGuardOutcome<T> =
  // The pick's album is fresh, exempt or untitled.
  | { kind: 'none' }
  // Fired, and the pick stands anyway.
  | { kind: 'kept' }
  // Fired and the re-pick landed: use these in place of the original pick.
  | { kind: 'repicked'; object: { id?: string | null } & Record<string, unknown>; song: T };

// Which artist an album re-pick may never land on: the pick ANCHOR's (the
// track on air, or the queue head under pair drain), whatever the artist guard
// decided. Passing it only after an artist RE-PICK left the common case open:
// the artist guard KEPT a recent-window pick (every alternative was a recent
// artist, so spacing yielded), the album guard then found that pick's album
// recent, starved, waived the artist exclusion and re-picked the on-air
// artist — Prefab Sprout straight after Prefab Sprout (trace 412fbc72). An
// album repeat ten minutes on is milder than the same artist twice in a row,
// so with only the anchor artist on another record the pick is kept.
// Two exceptions return ''. An episode source runs no artist guard at all, by
// design. And a `song` that is itself by the anchor artist is a repeat the
// artist guard already CONCEDED (an anchor match that neither its re-pick nor
// its pool rescue could move): excluding the anchor then cannot prevent that
// repeat, only strip the other-album candidates and keep the on-air record
// too. With the spacing window on, the album guard's own neighbour preference
// still steers away from the anchor artist in that case, since the anchor is in
// `avoidArtistRoots`; with it off (0) nothing does, exactly as before #1981.
// `song` is the pick the artist guard left standing; a successful artist
// re-pick is never by the anchor (the artist guard validates that), so the
// re-pick still keeps its anchor exclusion.
export function albumGuardAnchorRoot(
  pickAnchor: CandidateLike | null | undefined,
  song: CandidateLike | null | undefined,
  episodeSource: boolean,
): string {
  if (episodeSource) return '';
  const anchorRoot = artistRootKey(pickAnchor || {});
  return artistCreditsOverlap(artistRootKey(song || {}), anchorRoot) ? '' : anchorRoot;
}

// Everything injected — no queue, no settings, no model — so the "never spends
// more than one re-pick" guarantee is an assertion counting injected calls.
export interface AlbumGuardDeps<T> {
  song: T;
  object: { id?: string | null } & Record<string, unknown>;
  /** The run's own candidates, keyed by id, as pickViaSelectionRoute's `extras.seen`. */
  seen: Iterable<[string, T]>;
  /** queue.recentAlbumKeys(hours) — the caller owns every queue read. */
  recentAlbums: Set<string>;
  /** queue.neighbourArtistRoots(window). */
  avoidArtistRoots: Set<string>;
  /** The pick anchor's artist (albumGuardAnchorRoot). Not relaxable. */
  avoidAnchorRoot?: string;
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
  const { song, seen, recentAlbums, avoidArtistRoots, avoidAnchorRoot = '', albumKeyOf, hours, repick, log, logEvent } = deps;

  const key = albumKeyOf(song);
  // '' covers exemptions and the untagged: a compilation keys as nothing on
  // BOTH sides, so it neither blocks nor is blocked.
  if (!key || !recentAlbums.has(key)) return { kind: 'none' };

  const { alt, dropped, starved, anchorSkipped } = alternativeAlbumCandidates<T>(
    seen, recentAlbums, albumKeyOf, avoidArtistRoots, avoidAnchorRoot,
  );

  // Two different runs end here, and the booth must not call one the other:
  // a run that really was all recent records, and one whose only other records
  // were by the pick-anchor artist, kept off back-to-back on purpose.
  if (!alt.size) {
    logEvent('pick.albumGuard', {
      relaxed: true, reason: anchorSkipped ? 'only-anchor-artist' : 'no-other-album',
      album: song.album, artist: song.artist, anchorSkipped, hours,
    });
    log(anchorSkipped
      ? `recently-played album "${song.album}" allowed — the run's only other-album candidate(s) were by the pick-anchor artist, kept off back-to-back (album cooldown ${hours}h)`
      : `recently-played album "${song.album}" allowed — every candidate in the run came off it (album cooldown ${hours}h)`);
    return { kind: 'kept' };
  }

  const repicked = await repick(
    alt,
    `The track you chose is from ${song.album}, a record already played in the last few hours — don't return to the same album that soon. Choose a track from a DIFFERENT album among the candidates above.`,
  );
  // Resolved out of `alt`, not the full `seen`, so the re-pick can only land
  // on something it was offered.
  const altSong = repicked?.id ? alt.get(repicked.id) : null;
  if (altSong && repicked && !artistCreditsOverlap(artistRootKey(altSong), avoidAnchorRoot)) {
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
