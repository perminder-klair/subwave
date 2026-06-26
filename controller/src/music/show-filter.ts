// Shared show-music filter helpers — one source of truth for "does this track
// fit the show's genre / era constraint?", used by BOTH pick paths: the
// stateless pool picker (music/picker.ts) and the conversational agent's
// discovery tools (llm/internal/tools/picker-tools.ts). Keeping them here stops
// the two paths from drifting on what "in-genre" / "in-era" means.

import * as library from './library.js';

// ── Genre ──────────────────────────────────────────────────────────────────

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
// rather than emptying the source (never-starve, mirrors preferEra).
export function preferGenre(tracks: any[], genreName?: string | null): any[] {
  if (!genreName) return tracks;
  const target = normGenre(genreName);
  if (!target) return tracks;
  const match = tracks.filter((t: any) => genreMatches(t, target));
  return match.length ? match : tracks;
}

// ── Era (decade / year window) ───────────────────────────────────────────────

type YearRange = { fromYear?: number | null; toYear?: number | null };

// Hard-filter to tracks within [fromYear, toYear]. Unknown-year tracks are
// treated as out-of-range (dropped). Callers that must not starve should use
// preferEra (or fall back to the full set themselves).
export function inYearRange(tracks: any[], f: YearRange): any[] {
  if (f.fromYear == null && f.toYear == null) return tracks;
  return tracks.filter((t: any) => {
    const y = Number(t?.year);
    if (!Number.isFinite(y)) return false;
    if (f.fromYear != null && y < f.fromYear) return false;
    if (f.toYear != null && y > f.toYear) return false;
    return true;
  });
}

// Never-starve era filter: in-range tracks first, falling back to the full set
// when nothing is in range, so a thin era degrades to off-era rather than
// emptying the source. Mirrors preferGenre's contract.
export function preferEra(tracks: any[], f: YearRange): any[] {
  if (f.fromYear == null && f.toYear == null) return tracks;
  const match = inYearRange(tracks, f);
  return match.length ? match : tracks;
}
