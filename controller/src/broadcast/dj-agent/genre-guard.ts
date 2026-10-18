// Best-effort genre-run limit at the agent's point of choice. No queue,
// settings or model reads here; the caller supplies the aired history, the
// same constrained re-pick used by the artist/album guards, and (optionally)
// one steer-away discovery call for the case where every candidate is in the
// run's genre.
import { aliasValue, sceneKey, type SceneAliasMap } from '../../music/scene-vocab.js';
import type { CandidateLike } from '../../music/recency.js';
import { alternativeCandidates } from './artist-guard.js';
import { describeRunKey } from './genre-families.js';

export { genreKeysWithFamilies } from './genre-families.js';

// Label keys reuse the operator's scene consolidations; otherwise each label
// keeps its normalized identity. `genreKeysWithFamilies` adds the small
// built-in family tokens on top.
export function genreLabelKeys(labels: readonly unknown[], aliases: SceneAliasMap): Set<string> {
  return new Set(labels.map(label => typeof label === 'string' ? sceneKey(aliasValue(label, aliases)) : '').filter(Boolean));
}

// `recentGenres` is newest first, including the current confirmed airing.
// Unknown metadata breaks the evidence of a run, rather than inventing one.
export function runGenreKeys(recentGenres: readonly ReadonlySet<string>[], window: number): Set<string> {
  if (window <= 0 || recentGenres.length < window) return new Set();
  return new Set([...recentGenres[0]].filter(label => recentGenres.slice(1, window).every(labels => labels.has(label))));
}

function labelsOverlap(labels: ReadonlySet<string>, runLabels: ReadonlySet<string>): boolean {
  return [...labels].some(label => runLabels.has(label));
}

export function genreGuardCause(pickGenres: ReadonlySet<string>, recentGenres: readonly ReadonlySet<string>[], window: number): boolean {
  return labelsOverlap(pickGenres, runGenreKeys(recentGenres, window));
}

export type GenreGuardOutcome<T> =
  | { kind: 'none' }
  | { kind: 'kept' }
  | { kind: 'repicked'; object: { id?: string | null } & Record<string, unknown>; song: T };

export interface GenreGuardDeps<T> {
  song: T;
  seen: Iterable<[string, T]>;
  recentGenres: readonly ReadonlySet<string>[];
  window: number;
  genreKeysOf: (song: T) => ReadonlySet<string>;
  recentRoots: Set<string>;
  // Preserve the artist policy's always-on pick-anchor exclusion.
  avoidAnchorRoot?: string;
  repick: (alt: Map<string, T>, reason: string) => Promise<({ id?: string | null } & Record<string, unknown>) | null>;
  // One extra discovery call, made only when no eligible candidate lies
  // outside the run's genre. It returns candidates steered away from the
  // run (for example sound-alikes of the current feel). The guard filters
  // them the same way as `seen`. Absent or empty means keep the pick.
  steer?: () => Promise<Map<string, T> | null | undefined>;
  // Album cooldown, when it is on. Outside-run candidates on a recently aired
  // album are set aside while any fresh-album one exists, so this guard cannot
  // undo the album guard. With none left, the cooldown relaxes (never starve).
  recentAlbums?: ReadonlySet<string>;
  albumKeyOf?: (song: T) => string;
  log: (line: string) => void;
  logEvent: (name: string, payload: Record<string, unknown>) => void;
}

export async function runGenreGuard<T extends CandidateLike>(deps: GenreGuardDeps<T>): Promise<GenreGuardOutcome<T>> {
  const { song, seen, recentGenres, window, genreKeysOf, recentRoots, avoidAnchorRoot = '', repick, steer, recentAlbums, albumKeyOf, log, logEvent } = deps;
  // Off is a true no-op: no metadata lookups, candidate walks or telemetry.
  if (window <= 0) return { kind: 'none' };
  const runLabels = runGenreKeys(recentGenres, window);
  if (!runLabels.size || !labelsOverlap(genreKeysOf(song), runLabels)) return { kind: 'none' };
  const genres = [...runLabels];
  const label = genres.map(describeRunKey).join(', ');

  const outsideRun = (candidates: Iterable<[string, T]>) => [...candidates].filter(([, s]) => {
    const keys = genreKeysOf(s);
    return keys.size > 0 && !labelsOverlap(keys, runLabels);
  });
  let albumRelaxed = false;
  const narrow = (candidates: Iterable<[string, T]>) => {
    let pool = outsideRun(candidates);
    if (recentAlbums?.size && albumKeyOf) {
      const fresh = pool.filter(([, s]) => { const key = albumKeyOf(s); return !key || !recentAlbums.has(key); });
      if (fresh.length) pool = fresh;
      else if (pool.length) albumRelaxed = true;
    }
    // Reuse the artist policy, including its never-starve spacing relaxation.
    return alternativeCandidates(pool, '', recentRoots, avoidAnchorRoot);
  };
  let { alt, starved: artistStarved } = narrow(seen);
  // Every candidate is in the run's genre: make the one steer-away call, then
  // judge its results by the same rules. Never called when an outside
  // candidate already exists.
  let steered = false;
  let steerReturned = 0;
  if (!alt.size && steer) {
    steered = true;
    let extra: Map<string, T> | null | undefined = null;
    try { extra = await steer(); } catch { extra = null; }
    steerReturned = extra?.size ?? 0;
    if (extra?.size) ({ alt, starved: artistStarved } = narrow(extra));
  }
  if (alt.size) {
    const repicked = await repick(alt,
      `The last ${window} aired tracks all carry these genre labels: ${JSON.stringify(genres.map(describeRunKey))}. Your pick carries at least one of them and would extend that run. Choose a track carrying none of those labels from the candidates above, keeping the transition smooth.`);
    const altSong = repicked?.id ? alt.get(repicked.id) : null;
    if (altSong && repicked) {
      logEvent('pick.genreGuard', { relaxed: false, genres, window, from: song.title, to: altSong.title, candidates: alt.size, artistStarved, albumRelaxed, steered });
      log(`genre run "${label}" avoided — re-picked "${altSong.title}" by ${altSong.artist} after ${window} same-genre airings${steered ? ' (from one steer-away search)' : ''}${artistStarved ? ' (artist spacing waived)' : ''}`);
      return { kind: 'repicked', object: repicked, song: altSong };
    }
  }
  const reason = alt.size ? 'repick-failed' : steered ? 'steer-empty' : 'no-other-genre';
  logEvent('pick.genreGuard', { relaxed: true, reason, genres, window, candidates: alt.size, steered, steerReturned });
  log(`genre run "${label}" allowed — ${alt.size ? 'constrained re-pick did not land' : steered ? 'the steer-away search found no eligible track outside the genre' : 'no known non-overlapping genre labels among eligible candidates'} (run limit ${window}, relaxed)`);
  return { kind: 'kept' };
}
