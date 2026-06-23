// Pure helper: which track IDs phase-0 enrichment (Last.fm tags + lyrics) runs
// over for a given tagger run. Extracted from tag-library.main() so the scope
// decision is unit-pinned (scripts/lastfm-enrich.test.ts) — kept in its own
// module because tag-library.ts runs main() on import and so can't be imported
// by a test.
//
// Normal runs enrich only the in-scope untagged tracks. A --re-enrich pass is an
// explicit "refresh the whole library" request, so it widens to the full walked
// catalogue (limit-capped). Passing the untagged set there is what made
// re-enrich a silent no-op on a fully-tagged library — untagged is empty, so
// phase 0 exited immediately (issue #531).

export function selectEnrichIds(opts: {
  reEnrich: boolean;
  limit: number;
  liveIds: Iterable<string>;
  targetUntagged: string[];
}): string[] {
  if (!opts.reEnrich) return opts.targetUntagged;
  const all = [...opts.liveIds];
  return opts.limit === Infinity ? all : all.slice(0, opts.limit);
}
