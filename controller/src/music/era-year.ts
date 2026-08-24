// The one definition of the year a track's ERA is judged by (issue
// #842/#1418). Kept below show-filter so storage writes can detect when an
// era-bearing text vector becomes stale without importing the library-facing
// filter module back into library-db.

// Precedence: the resolved original release year (walk-time album tag,
// MusicBrainz enrichment, or manual override) wins; a plain `year` counts only
// when it describes the recording rather than a compilation/reissue release.
//
// Junk-year guard shared by both fields: Number(null)/Number('') are 0, and
// some taggers write TYER=0000. A real recording year is always > 0, so null,
// blank, non-finite and non-positive values all read as unknown.
export function resolveEraYear(
  year: number | string | null | undefined,
  originalYear: number | null | undefined,
  yearUntrusted: boolean | null | undefined,
): number | null {
  const oy = Number(originalYear);
  if (Number.isFinite(oy) && oy > 0) return oy;
  if (yearUntrusted) return null;
  const y = Number(year);
  return Number.isFinite(y) && y > 0 ? y : null;
}
