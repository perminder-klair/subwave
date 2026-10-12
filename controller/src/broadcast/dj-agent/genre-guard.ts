// Best-effort genre-run limit at the agent's point of choice. No queue,
// settings or model reads here; the caller supplies the aired history and
// the same constrained re-pick used by the artist/album guards.
import { aliasValue, sceneKey, type SceneAliasMap } from '../../music/scene-vocab.js';
import type { CandidateLike } from '../../music/recency.js';
import { alternativeCandidates } from './artist-guard.js';

// There is no built-in genre-family taxonomy. Reuse the operator's scene
// consolidations; otherwise a primary label keeps its normalized identity.
export function primaryGenreKey(label: unknown, aliases: SceneAliasMap): string {
  return typeof label === 'string' ? sceneKey(aliasValue(label, aliases)) : '';
}

// `recentGenres` is newest first, including the current confirmed airing.
// Unknown metadata breaks the evidence of a run, rather than inventing one.
export function genreGuardCause(pickGenre: string, recentGenres: readonly string[], window: number): boolean {
  return window > 0 && !!pickGenre && recentGenres.length >= window
    && recentGenres.slice(0, window).every(genre => genre === pickGenre);
}

export type GenreGuardOutcome<T> =
  | { kind: 'none' }
  | { kind: 'kept' }
  | { kind: 'repicked'; object: { id?: string | null } & Record<string, unknown>; song: T };

export interface GenreGuardDeps<T> {
  song: T;
  seen: Iterable<[string, T]>;
  recentGenres: readonly string[];
  window: number;
  genreKeyOf: (song: T) => string;
  recentRoots: Set<string>;
  // Preserve the artist policy's always-on pick-anchor exclusion.
  avoidAnchorRoot?: string;
  repick: (alt: Map<string, T>, reason: string) => Promise<({ id?: string | null } & Record<string, unknown>) | null>;
  log: (line: string) => void;
  logEvent: (name: string, payload: Record<string, unknown>) => void;
}

export async function runGenreGuard<T extends CandidateLike>(deps: GenreGuardDeps<T>): Promise<GenreGuardOutcome<T>> {
  const { song, seen, recentGenres, window, genreKeyOf, recentRoots, avoidAnchorRoot = '', repick, log, logEvent } = deps;
  // Off is a true no-op: no metadata lookups, candidate walks or telemetry.
  if (window <= 0) return { kind: 'none' };
  const genre = genreKeyOf(song);
  if (!genreGuardCause(genre, recentGenres, window)) return { kind: 'none' };

  const base = [...seen].filter(([, s]) => {
    const key = genreKeyOf(s);
    return !!key && key !== genre;
  });
  // Reuse the artist policy, including its never-starve spacing relaxation.
  const { alt, starved: artistStarved } = alternativeCandidates(base, '', recentRoots, avoidAnchorRoot);
  if (alt.size) {
    const repicked = await repick(alt,
      `The last ${window} aired tracks share the primary genre "${genre}". Your pick would extend that run. Choose a track outside that genre from the candidates above, keeping the transition smooth.`);
    const altSong = repicked?.id ? alt.get(repicked.id) : null;
    if (altSong && repicked) {
      logEvent('pick.genreGuard', { relaxed: false, genre, window, from: song.title, to: altSong.title, candidates: alt.size, artistStarved });
      log(`genre run "${genre}" avoided — re-picked "${altSong.title}" by ${altSong.artist} after ${window} same-genre airings${artistStarved ? ' (artist spacing waived)' : ''}`);
      return { kind: 'repicked', object: repicked, song: altSong };
    }
  }
  const reason = alt.size ? 'repick-failed' : 'no-other-genre';
  logEvent('pick.genreGuard', { relaxed: true, reason, genre, window, candidates: alt.size });
  log(`genre run "${genre}" allowed — ${alt.size ? 'constrained re-pick did not land' : 'no known other genre among eligible candidates'} (run limit ${window}, relaxed)`);
  return { kind: 'kept' };
}
