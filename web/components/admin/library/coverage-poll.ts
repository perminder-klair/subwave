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
//    that cannot be read stops asking after a couple of minutes;
//  - a never-play write just made (`settle`). The Blocked tab's per-entry
//    figures come from the overview, and the controller answers the first
//    read after a write with the snapshot counted before it, recounting in
//    the background (music/library-overview.ts getOverview). So the page asks
//    again until a snapshot counted after the write lands: one whose
//    `computedAt` moved off the one held at the write (so a server clock
//    ahead of the browser's cannot end it early) and is later than the write.
//    Bounded, so a server clock behind the browser's costs a few reads, not
//    a poll.
export const COVERAGE_POLL_MS = 3_000;
export const COLD_START_MAX_READS = 40;
export const BLOCK_SETTLE_MAX_READS = 5;

/** A never-play write the figures must catch up with. `reads`: coverage reads since. */
export interface BlockSettle {
  writeAt: number;
  /** overview.computedAt as the page held it at the write. */
  baseline: string | null;
  reads: number;
}

// The last write, noted by block-actions.ts. One per page, like the query
// client it pairs with; `fromReads` is the coverage query's dataUpdateCount then.
let lastWrite: { writeAt: number; baseline: string | null; fromReads: number } | null = null;

export function noteBlockWrite(w: { writeAt: number; baseline: string | null; fromReads: number }): void {
  lastWrite = w;
}

/** The settle input for coveragePollMs, given the query's dataUpdateCount now. */
export function blockSettle(reads: number): BlockSettle | null {
  if (!lastWrite) return null;
  return { writeAt: lastWrite.writeAt, baseline: lastWrite.baseline, reads: Math.max(0, reads - lastWrite.fromReads) };
}

export function coveragePollMs(s: {
  taggerRunning: boolean;
  data: { scanning?: boolean; overview?: unknown } | null | undefined;
  reads: number;
  settle?: BlockSettle | null;
}): number | false {
  if (s.taggerRunning || s.data?.scanning) return COVERAGE_POLL_MS;
  const overview = s.data?.overview as { computedAt?: unknown } | null | undefined;
  if (s.settle && s.settle.reads < BLOCK_SETTLE_MAX_READS && overview) {
    const at = typeof overview.computedAt === 'string' ? overview.computedAt : null;
    const counted = at !== null && at !== s.settle.baseline && Date.parse(at) > s.settle.writeAt;
    if (!counted) return COVERAGE_POLL_MS;
  }
  // Only a controller that sends the key and has no figures yet: an older one
  // never sends `overview`, and would otherwise be polled for two minutes.
  if (s.data && 'overview' in s.data && s.data.overview === null && s.reads < COLD_START_MAX_READS) return COVERAGE_POLL_MS;
  return false;
}
