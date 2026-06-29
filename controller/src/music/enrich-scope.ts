// Pure helper: which track IDs phase-0 enrichment (Last.fm tags + lyrics) runs
// over for a given tagger run. Extracted from tag-library.main() so the scope
// decision is unit-pinned (scripts/lastfm-enrich.test.ts) — kept in its own
// module because tag-library.ts runs main() on import and so can't be imported
// by a test.
//
// Normal runs enrich only the in-scope untagged tracks. A raw --re-enrich pass
// is an explicit "refresh the whole library" request, so it widens to the full
// walked catalogue (limit-capped). Passing the untagged set there is what made
// re-enrich a silent no-op on a fully-tagged library — untagged is empty, so
// phase 0 exited immediately (issue #531).
//
// A RE-SCAN re-enrich is narrower than that: it redoes metadata only for tracks
// that were ALREADY enriched (`enrichedIds`), never the never-touched remainder —
// the "redo what's done, not the rest" rule. `enrichedIds` is the captured
// already-enriched set; it's only consulted when rescan && reEnrich.

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
