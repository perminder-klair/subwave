// Best-effort genre-run limit at the agent's point of choice. No queue,
// settings or model reads here; the caller supplies the tracks the pick will
// follow, the same constrained re-pick used by the artist/album guards, and
// (optionally) one steer-away discovery call for the case where every
// candidate is in the run's genre.
//
// It runs after the artist and album guards, on a pick that already passed
// them, so it never waives either: an alternative they would refuse is never
// offered, and with none left the pick stands. No slot is at stake, so their
// never-starve relaxations have nothing to rescue here.
import { ownsPickDirection } from '../../music/discovery-policy.js';
import type { CandidateLike } from '../../music/recency.js';
import { alternativeCandidates } from './artist-guard.js';
import { onFreshAlbum, type AlbumKeyOf } from './album-guard.js';
import type { GenreKeys } from './genre-families.js';
import type { GuardOutcome } from './leanings-review.js';

// Whether the guard runs for this pick at all. It is for whole-library
// programming: a show that sets its own genre list chose those genres, so a
// run inside them is the show doing its job. A prepared episode, a strict
// playlist or a sonic journey owns the pick's direction, the same exemption
// #1907's named run makes.
export function genreGuardApplies(
  scope: Parameters<typeof ownsPickDirection>[0],
  showGenres: readonly string[] | null | undefined,
): boolean {
  return !ownsPickDirection(scope) && !showGenres?.length;
}

// `recentGenres` is newest first: the slots the pick will follow. The run is
// named as the newest track spells it. Unknown metadata breaks the evidence of
// a run, rather than inventing one.
function runGenreKeys(recentGenres: readonly GenreKeys[], window: number): GenreKeys {
  if (window <= 0 || recentGenres.length < window) return new Map();
  return new Map([...recentGenres[0]].filter(([key]) => recentGenres.slice(1, window).every(keys => keys.has(key))));
}

function labelsOverlap(keys: GenreKeys, runKeys: GenreKeys): boolean {
  return [...keys.keys()].some(key => runKeys.has(key));
}

// The genre guard runs after the artist and album guards, so its re-pick is
// named beside theirs, never in place of them.
const WITH_GENRE: Partial<Record<GuardOutcome, GuardOutcome>> = {
  'artist-repick': 'artist-and-genre-repick',
  'album-repick': 'album-and-genre-repick',
  'artist-and-album-repick': 'artist-album-and-genre-repick',
};

export function withGenreRepick(outcome: GuardOutcome | undefined): GuardOutcome {
  return (outcome && WITH_GENRE[outcome]) || 'genre-repick';
}

export type GenreGuardOutcome<T> =
  | { kind: 'none' }
  | { kind: 'kept' }
  | { kind: 'repicked'; object: { id?: string | null } & Record<string, unknown>; song: T };

export interface GenreGuardDeps<T> {
  song: T;
  seen: Iterable<[string, T]>;
  recentGenres: readonly GenreKeys[];
  window: number;
  genreKeysOf: (song: T) => GenreKeys;
  // queue.neighbourArtistRoots(window): an alternative in it is never offered.
  recentRoots: Set<string>;
  // Preserve the artist policy's always-on pick-anchor exclusion.
  avoidAnchorRoot?: string;
  repick: (alt: Map<string, T>, reason: string) => Promise<({ id?: string | null } & Record<string, unknown>) | null>;
  // One extra discovery call, made only when every candidate is in the run's
  // genre. It returns candidates steered away from the run (for example
  // sound-alikes of the current feel). The guard filters them the same way as
  // `seen`. Absent or empty means keep the pick.
  steer?: () => Promise<Map<string, T> | null | undefined>;
  // Album cooldown, when it is on. An alternative on a recently aired album is
  // never offered.
  recentAlbums?: ReadonlySet<string>;
  albumKeyOf?: AlbumKeyOf<T>;
  log: (line: string) => void;
  logEvent: (name: string, payload: Record<string, unknown>) => void;
}

// Why a run was allowed to continue. The first three name the other guard
// that refused every alternative outside the run.
type KeptReason = 'album-cooldown' | 'anchor-artist' | 'artist-spacing' | 'steer-empty' | 'no-other-genre' | 'repick-failed';

const KEPT_BECAUSE: Record<KeptReason, string> = {
  'album-cooldown': 'every eligible track outside it is from a recently played album, and the album cooldown holds',
  'anchor-artist': 'the only tracks outside it are by the pick-anchor artist',
  'artist-spacing': 'every eligible track outside it is by a recently played artist, and artist spacing holds',
  'steer-empty': 'the steer-away search found no eligible track outside the genre',
  'no-other-genre': 'no known non-overlapping genre labels among eligible candidates',
  'repick-failed': 'constrained re-pick did not land',
};

export async function runGenreGuard<T extends CandidateLike>(deps: GenreGuardDeps<T>): Promise<GenreGuardOutcome<T>> {
  const { song, seen, recentGenres, window, genreKeysOf, recentRoots, avoidAnchorRoot = '', repick, steer, recentAlbums, albumKeyOf, log, logEvent } = deps;
  // Off is a true no-op: no metadata lookups, candidate walks or telemetry.
  if (window <= 0) return { kind: 'none' };
  const runLabels = runGenreKeys(recentGenres, window);
  if (!runLabels.size || !labelsOverlap(genreKeysOf(song), runLabels)) return { kind: 'none' };
  const genres = [...runLabels.keys()];
  const names = [...runLabels.values()];
  const label = names.join(', ');

  const outsideRun = (candidates: Iterable<[string, T]>) => [...candidates].filter(([, s]) => {
    const keys = genreKeysOf(s);
    return keys.size > 0 && !labelsOverlap(keys, runLabels);
  });
  // The outside-run candidates the album and artist guards would both accept,
  // or which of them refused the last one.
  const narrow = (candidates: Iterable<[string, T]>): { alt: Map<string, T>; heldBy: KeptReason | null } => {
    const pool = outsideRun(candidates);
    if (!pool.length) return { alt: new Map(), heldBy: null };
    const fresh = recentAlbums?.size && albumKeyOf ? pool.filter(([, s]) => onFreshAlbum(s, recentAlbums, albumKeyOf)) : pool;
    if (!fresh.length) return { alt: new Map(), heldBy: 'album-cooldown' };
    // The artist policy's own narrowing. Its `starved` set is the spacing
    // relaxation, which only a slot that would otherwise be lost may take.
    const { alt, starved } = alternativeCandidates(fresh, '', recentRoots, avoidAnchorRoot);
    if (!alt.size) return { alt, heldBy: 'anchor-artist' };
    if (starved) return { alt: new Map(), heldBy: 'artist-spacing' };
    return { alt, heldBy: null };
  };
  const candidates = [...seen];
  let { alt, heldBy } = narrow(candidates);
  // Every candidate is in the run's genre: make the one steer-away call, then
  // judge its results by the same rules. Not when the run's leftovers are
  // unlabelled, or outside it but refused by another guard: those are a
  // different situation, and the pick stands.
  let steered = false;
  let steerReturned = 0;
  if (steer && candidates.every(([, s]) => labelsOverlap(genreKeysOf(s), runLabels))) {
    steered = true;
    let extra: Map<string, T> | null | undefined = null;
    try { extra = await steer(); } catch { extra = null; }
    steerReturned = extra?.size ?? 0;
    if (extra?.size) ({ alt, heldBy } = narrow(extra));
  }
  if (alt.size) {
    const repicked = await repick(alt,
      `The ${window} tracks before this pick all carry these genre labels: ${JSON.stringify(names)}. Your pick carries at least one of them and would extend that run. Choose a track carrying none of those labels from the candidates above, keeping the transition smooth.`);
    const altSong = repicked?.id ? alt.get(repicked.id) : null;
    if (altSong && repicked) {
      logEvent('pick.genreGuard', { relaxed: false, genres, window, from: song.title, to: altSong.title, candidates: alt.size, steered });
      log(`genre run "${label}" avoided — re-picked "${altSong.title}" by ${altSong.artist} after ${window} same-genre tracks${steered ? ' (from one steer-away search)' : ''}`);
      return { kind: 'repicked', object: repicked, song: altSong };
    }
  }
  const reason: KeptReason = alt.size ? 'repick-failed' : heldBy ?? (steered ? 'steer-empty' : 'no-other-genre');
  logEvent('pick.genreGuard', { relaxed: true, reason, genres, window, candidates: alt.size, steered, steerReturned });
  log(`genre run "${label}" allowed — ${KEPT_BECAUSE[reason]} (run limit ${window}, relaxed)`);
  return { kind: 'kept' };
}
