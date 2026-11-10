export type CandidateDiagnostic = {
  strict: boolean;
  library: { indexed: number; matchingFilters: number; afterExclusions: number; effective: number };
  playlist: null | { total: number; matchingFilters: number; afterExclusions: number; effective: number };
  warnings: string[];
};

// A strict report names the configured selection pool, which can be the
// playlist intersection rather than every library-wide filter match. Soft
// reports keep showing filter fit because the wider pool is only a fallback.
export function displayedMatchingTracks(report: CandidateDiagnostic): number {
  return report.strict ? report.library.effective : report.library.afterExclusions;
}
