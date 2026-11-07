// When the Library page re-reads GET /library/coverage on its own.
//
// The read is cheap (DB counts plus the last-known music-server total), but
// it must not run on an idle timer (#1570): the server's count behind it is a
// walk the operator starts. So it polls only in live states:
//  - a tagging run, whose figures must climb;
//  - a count the operator just asked for (`scanning`);
//  - a controller that has no counts snapshot yet. After a restart the
//    controller answers `overview: null` and starts computing it in the
//    background (music/library-overview.ts getOverview), so the first read
//    always misses it. Without a poll the tiles stayed at "…" until the
//    operator reloaded the page, often more than once. Bounded, so a library
//    that cannot be read stops asking after a couple of minutes.
export const COVERAGE_POLL_MS = 3_000;
export const COLD_START_MAX_READS = 40;

export function coveragePollMs(s: {
  taggerRunning: boolean;
  data: { scanning?: boolean; overview?: unknown } | null | undefined;
  reads: number;
}): number | false {
  if (s.taggerRunning || s.data?.scanning) return COVERAGE_POLL_MS;
  if (s.data && s.data.overview == null && s.reads < COLD_START_MAX_READS) return COVERAGE_POLL_MS;
  return false;
}
