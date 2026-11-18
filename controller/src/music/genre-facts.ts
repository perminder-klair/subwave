// Resolve a candidate's genre keys for the genre-run guard (#1897). Injected
// into the guard the way `album-facts.albumKeyFor` is into the album guard, so
// every library read stays at the call site's resolver.
//
// The library mirror is the source: its `genres` were written by the ingest
// normaliser (`subsonic.songGenres`), which already applied the operator's
// scene consolidations, and a merge rewrites the mirror in place. So no alias
// runs here; a second pass could only disagree with the first.

import { genreKeysWithFamilies, type GenreKeys } from '../broadcast/dj-agent/genre-families.js';
import * as library from './library.js';
import type { CandidateLike } from './recency.js';
import * as subsonic from './subsonic.js';

type GenreCandidate = CandidateLike & { genres?: unknown; genre?: unknown };

export function genreKeysFor(track: GenreCandidate | null | undefined): GenreKeys {
  return genreKeysWithFamilies(genreLabelsFor(track));
}

// A track the mirror does not hold keeps only an unambiguous list of its own:
// a raw Subsonic child's `genres` array, or a `genre` field holding ONE label.
// The discovery projection (`slim`) joins several labels with ", ", and a
// label may itself contain one ("Folk, World, & Country"), so a joined field
// reads as unknown rather than being split into labels nobody tagged. Unknown
// breaks a run and is never offered as an alternative.
function genreLabelsFor(track: GenreCandidate | null | undefined): string[] {
  if (!track) return [];
  const rec = track.id ? library.get(track.id) : null;
  if (Array.isArray(rec?.genres)) return rec.genres;
  const labels = subsonic.songGenres(track);
  if (Array.isArray(track.genres)) return labels;
  return labels.some(label => label.includes(', ')) ? [] : labels;
}
