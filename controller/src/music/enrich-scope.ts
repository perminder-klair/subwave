// Which track IDs phase-0 enrichment (Last.fm tags + lyrics) runs over. Its own
// module because tag-library.ts runs main() on import and can't be test-imported.
//
// Normal runs enrich only the in-scope untagged tracks. A raw --re-enrich widens
// to the full walked catalogue (limit-capped) — passing the untagged set there
// made re-enrich a no-op on a fully-tagged library (#531). A RE-SCAN re-enrich
// redoes only tracks already enriched (`enrichedIds`), never the remainder.

export function selectEnrichIds(opts: {
  reEnrich: boolean;
  rescan?: boolean;
  limit: number;
  liveIds: Iterable<string>;
  enrichedIds?: Iterable<string>;
  targetUntagged: string[];
}): string[] {
  if (!opts.reEnrich) return opts.targetUntagged;
  const source = opts.rescan ? [...(opts.enrichedIds ?? [])] : [...opts.liveIds];
  return opts.limit === Infinity ? source : source.slice(0, opts.limit);
}
