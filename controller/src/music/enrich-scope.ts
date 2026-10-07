// Normal enrichment targets untagged tracks. Re-enrich targets the limit-capped catalogue;
// rescan re-enrich targets only previously enriched tracks. #531.

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
