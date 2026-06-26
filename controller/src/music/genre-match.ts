// Shared genre-matching helpers — one source of truth for "does this track
// belong to the show's genre?", used by BOTH pick paths: the stateless pool
// picker (music/picker.ts) and the conversational agent's discovery tools
// (llm/internal/tools/picker-tools.ts). Keeping them here stops the two paths
// from drifting on what "in-genre" means.

import * as library from './library.js';

// Normalised genre token for fuzzy comparison — mirrors subsonic.resolveGenreName
// so the show's resolved tag and a track's tag compare the same way.
export function normGenre(s: any): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Per-track genre — from the track itself (Subsonic + slimTrack library sources
// both carry it) or a library lookup. null when the track has no genre tag.
export function trackGenre(t: any): string | null {
  if (t?.genre) return t.genre;
  const rec = t?.id ? library.get(t.id) : null;
  return rec?.genre ?? null;
}

// True when a track's genre matches the (already library-resolved) target genre.
// Exact-normalised match, or substring either way — same shape as
// subsonic.resolveGenreName, so "Hip-Hop" matches a "Hip Hop" tag etc.
export function genreMatches(t: any, targetNorm: string): boolean {
  const g = trackGenre(t);
  if (!g) return false;
  const gn = normGenre(g);
  return !!gn && (gn === targetNorm || gn.includes(targetNorm) || targetNorm.includes(gn));
}

// Hard-prefer tracks matching the show's genre (strict mode). Unlike the soft
// energy/year leans, an untagged or off-genre track does NOT stay eligible —
// the whole point of strict is a genre-pure pool. But it FALLS BACK to the
// unfiltered set when no track matches, so a thin genre degrades to off-genre
// rather than emptying the source (never-starve, mirrors preferEnergy/inYearRange).
export function preferGenre(tracks: any[], genreName?: string | null): any[] {
  if (!genreName) return tracks;
  const target = normGenre(genreName);
  if (!target) return tracks;
  const match = tracks.filter((t: any) => genreMatches(t, target));
  return match.length ? match : tracks;
}
