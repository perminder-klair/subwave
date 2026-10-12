// Best-effort genre-run limit at the agent's point of choice. No queue,
// settings or model reads here; the caller supplies the aired history and
// the same constrained re-pick used by the artist/album guards.
import { aliasValue, sceneKey, type SceneAliasMap } from '../../music/scene-vocab.js';
import type { CandidateLike } from '../../music/recency.js';
import { alternativeCandidates } from './artist-guard.js';

// There is no built-in genre-family taxonomy. Reuse the operator's scene
// consolidations; otherwise each label keeps its normalized identity.
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
  log: (line: string) => void;
  logEvent: (name: string, payload: Record<string, unknown>) => void;
}

export async function runGenreGuard<T extends CandidateLike>(deps: GenreGuardDeps<T>): Promise<GenreGuardOutcome<T>> {
  const { song, seen, recentGenres, window, genreKeysOf, recentRoots, avoidAnchorRoot = '', repick, log, logEvent } = deps;
  // Off is a true no-op: no metadata lookups, candidate walks or telemetry.
  if (window <= 0) return { kind: 'none' };
  const runLabels = runGenreKeys(recentGenres, window);
  if (!runLabels.size || !labelsOverlap(genreKeysOf(song), runLabels)) return { kind: 'none' };
  const genres = [...runLabels];
  const label = genres.join(', ');

  const base = [...seen].filter(([, s]) => {
    const keys = genreKeysOf(s);
    return keys.size > 0 && !labelsOverlap(keys, runLabels);
  });
  // Reuse the artist policy, including its never-starve spacing relaxation.
  const { alt, starved: artistStarved } = alternativeCandidates(base, '', recentRoots, avoidAnchorRoot);
  if (alt.size) {
    const repicked = await repick(alt,
      `The last ${window} aired tracks all carry these genre labels: ${JSON.stringify(genres)}. Your pick carries at least one of them and would extend that run. Choose a track carrying none of those labels from the candidates above, keeping the transition smooth.`);
    const altSong = repicked?.id ? alt.get(repicked.id) : null;
    if (altSong && repicked) {
      logEvent('pick.genreGuard', { relaxed: false, genres, window, from: song.title, to: altSong.title, candidates: alt.size, artistStarved });
      log(`genre run "${label}" avoided — re-picked "${altSong.title}" by ${altSong.artist} after ${window} shared-label airings${artistStarved ? ' (artist spacing waived)' : ''}`);
      return { kind: 'repicked', object: repicked, song: altSong };
    }
  }
  const reason = alt.size ? 'repick-failed' : 'no-other-genre';
  logEvent('pick.genreGuard', { relaxed: true, reason, genres, window, candidates: alt.size });
  log(`genre run "${label}" allowed — ${alt.size ? 'constrained re-pick did not land' : 'no known non-overlapping genre labels among eligible candidates'} (run limit ${window}, relaxed)`);
  return { kind: 'kept' };
}
