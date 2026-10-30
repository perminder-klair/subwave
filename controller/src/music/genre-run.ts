// Genre run: how long the set has stayed inside ONE of a multi-genre show's
// genres. Pure, so the Track Shortlist call can be told about a run without the
// model having to infer it from per-track tags it is not shown.
//
// Why it exists: the Shortlist orders its list by transition fit and asks for
// "ordinary musical flow", and the continuity sources are seeded from the
// track on air. Each pick therefore favours the genre that is already playing,
// and a show that allows five genres drifts into one of them for a whole hour.
// The Agentic route does not need this — its model chooses its own searches
// and reads the set from its session history.
//
// A preference, never a filter: the caller only names the run to the model.

import { genreMatches, normGenre, type FilterTrack } from './show-filter.js';

// Three in a row is a run worth naming; two is ordinary continuity.
export const GENRE_RUN_MIN_PLAYS = 3;

// How far back the run may be counted. Bounded so the figure handed to the
// model stays a fact about the recent set, not the whole show.
const GENRE_RUN_MAX_PLAYS = 10;

export type GenreRun = { genre: string; plays: number };

// `recent` is newest first (the on-air track, then history). The run is the
// longest unbroken stretch of recent tracks that all match one of the show's
// genres, matched through show-filter's one-directional genreMatches so a
// "Punjabi Pop" tag counts as the show's "Punjabi". A track matching several
// show genres keeps every one it shares with the run; the run ends at the
// first track that shares none, or that carries no genre at all — an untagged
// track is not evidence of a repeat.
//
// Null when the show has fewer than two genres (there is nowhere else to go),
// or when the run is shorter than GENRE_RUN_MIN_PLAYS.
export function genreRun(recent: Array<FilterTrack | null | undefined>, showGenres: readonly string[] | null | undefined): GenreRun | null {
  const genres = [...new Set((showGenres ?? []).filter(g => typeof g === 'string' && normGenre(g)))];
  if (genres.length < 2) return null;

  let shared = genres;
  let plays = 0;
  for (const track of recent.slice(0, GENRE_RUN_MAX_PLAYS)) {
    if (!track) break;
    const next = shared.filter(genre => genreMatches(track, [normGenre(genre)]));
    if (!next.length) break;
    shared = next;
    plays++;
  }
  // A run spanning every show genre is no run at all (every track was tagged
  // with all of them, so steering away has nowhere to go).
  if (plays < GENRE_RUN_MIN_PLAYS || shared.length === genres.length) return null;
  return { genre: shared[0], plays };
}
