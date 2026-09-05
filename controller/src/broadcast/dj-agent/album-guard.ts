// Album cooldown policy on the agent path — pure, unit-pinned (#1485 FR 3).
//
// Same shape and the same reason as artist-guard.ts next door: the discovery
// tools carry NO album filter, because a filter inside the tools gutted the
// similarity pool on niche catalogues (#618) and an album strip would be worse
// than the artist one it was measured on — `tracksLikeThis` around an album
// track routinely answers with that album. So the cooldown is enforced at the
// POINT OF CHOICE, over the run's own candidates, exactly where the artist
// guard is.
//
// It is deliberately the SOFTEST guard in that sequence — it behaves like the
// artist guard's 'recent' cause and never like its 'onair' one:
//
//   * no pool rescue, ever. The pool path applies the same cooldown itself
//     (queue.recentAlbumKeys feeds filterPickerCandidates), so a rescue call
//     could only ask a second time a question the caller already answered —
//     at the cost of a whole extra model round trip on a transition.
//   * a failed re-pick keeps the original pick. Two tracks off one record a few
//     hours apart is a taste preference, and a preference must never cost the
//     station a slot.
//
// The guard runs AFTER the artist guard, on whatever pick that left standing,
// and its alternatives step around the same neighbouring artists — see
// alternativeAlbumCandidates.

import { artistRootKey, type CandidateLike } from '../../music/recency.js';

// How a candidate's album key is resolved. The caller supplies it — this module
// owns no lookups, for the same reason artist-guard takes `recentRoots` as a
// value: every read stays at the call site. In production that is
// `music/album-facts.albumKeyFor`, which fills in the compilation flags the
// agent's `seen` map deliberately does not carry (those values go verbatim into
// a re-pick prompt, so a field added there is a field the model reads).
export type AlbumKeyOf<T> = (song: T) => string;

export interface AlbumAlternativePool<T> {
  /** The candidates a re-pick may choose from, keyed by id as `seen` is. */
  alt: Map<string, T>;
  /** How many fresh-album candidates the artist exclusion removed. */
  dropped: number;
  /**
   * True when every fresh-album alternative was ALSO a neighbouring artist and
   * the artist exclusion was waived. `dropped` is 0 in that case too, so this
   * is what tells "the exclusion was a no-op" from "it was overruled".
   */
  starved: boolean;
}

// The candidate set for an album re-pick.
//
// `recentAlbums` is queue.recentAlbumKeys(hours) and already contains the
// rejected pick's own album, so it is the only exclusion the album axis needs.
// A candidate whose albumKey is '' — untitled, untagged, or an exempt
// compilation — is NEVER dropped, for the reason the artist guard never drops
// an untagged artist: absence of a name is not evidence of a repeat.
//
// `avoidArtistRoots` is the artist guard's own window (queue.neighbourArtistRoots).
// It is here because the two guards run in sequence over one pick: without it
// an album re-pick could hand back the very artist the guard immediately before
// it just stepped around, and the pick would leave the pair of them worse than
// it arrived. It is a PREFERENCE though, not a second artist guard — when every
// fresh-album alternative is a neighbouring artist the unnarrowed set comes
// back (`starved`), because the artist guard has already had its say on this
// pick and re-litigating it here would just empty the pool.
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

// ── The guard itself ───────────────────────────────────────────────────────

export type AlbumGuardOutcome<T> =
  // The pick's album is fresh, exempt or untitled — the overwhelming majority.
  | { kind: 'none' }
  // Fired, and the pick stands anyway. Relaxed, logged, slot still ours.
  | { kind: 'kept' }
  // Fired and the re-pick landed: use these in place of the original pick.
  | { kind: 'repicked'; object: { id?: string | null } & Record<string, unknown>; song: T };

// Everything the guard needs, injected — no queue, no settings, no model, for
// the reason ArtistGuardDeps gives: it is what makes the wiring testable
// without a model call, and the "never spends more than one re-pick" guarantee
// IS an assertion counting the injected calls.
export interface AlbumGuardDeps<T> {
  song: T;
  object: { id?: string | null } & Record<string, unknown>;
  /** The run's own candidates, keyed by id, as pickViaAgent's `extras.seen`. */
  seen: Iterable<[string, T]>;
  /** queue.recentAlbumKeys(hours) — the caller owns every queue read. */
  recentAlbums: Set<string>;
  /** queue.neighbourArtistRoots(window) — see alternativeAlbumCandidates. */
  avoidArtistRoots: Set<string>;
  /** Resolves a candidate's album key — see AlbumKeyOf. */
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
  // '' covers the exemptions as well as the untagged: a compilation keys as
  // nothing on BOTH sides, so it neither blocks nor is blocked.
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
  // Resolved out of `alt` rather than the full `seen`, so the re-pick can only
  // land on something it was actually offered — the same rule the artist
  // guard's re-pick follows.
  const altSong = repicked?.id ? alt.get(repicked.id) : null;
  if (altSong && repicked) {
    logEvent('pick.albumGuard', {
      relaxed: false, from: song.album, to: altSong.album,
      candidates: alt.size, artistSkipped: dropped, artistStarved: starved, hours,
    });
    log(`recently-played album "${song.album}" avoided — re-picked "${altSong.title}" by ${altSong.artist} from ${alt.size} other-album candidate(s)${dropped ? `, ${dropped} more skipped as recently-played artists` : ''}${starved ? ' (every alternative was a recent artist — artist exclusion waived)' : ''}`);
    return { kind: 'repicked', object: repicked, song: altSong };
  }

  // The run surfaced another album and the model declined to take it. Spending
  // a second call chasing a preference is exactly what this guard promises not
  // to do, so the original pick stands — logged, so a repeat is never silent.
  logEvent('pick.albumGuard', {
    relaxed: true, reason: 'repick-failed',
    album: song.album, artist: song.artist, candidates: alt.size, hours,
  });
  log(`recently-played album "${song.album}" allowed — re-pick from ${alt.size} other-album candidate(s) didn't land (album cooldown ${hours}h)`);
  return { kind: 'kept' };
}
