// The one definition of the year a track's ERA is judged by (#842/#1418). Kept
// below show-filter so library-db can use it without importing the filter module.

// Precedence: the resolved original release year (album tag, MusicBrainz, or
// manual override) wins; a plain `year` counts only when it describes the
// recording rather than a compilation/reissue release. Junk-year guard on both:
// null/blank/non-finite/non-positive (some taggers write TYER=0000) = unknown.
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
