// Normal enrichment targets untagged tracks. Re-enrich targets the limit-capped catalogue;
// rescan re-enrich targets only previously enriched tracks. #531.

import { shuffle } from '../util/shuffle.js';

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

// Who a pass asks Last.fm about, song by song. A normal pass covers the rows
// still owed, whatever the tagger's own scope: gating on that would never
// backfill an already-tagged library. This run's new tracks go first, so a
// --limit can't leave them to be embedded without tags. --re-enrich re-asks
// answered rows too, within the scope the caller already resolved for it, which
// is what keeps it inside --limit and a re-scan's already-enriched population.
//
// The order is new every pass. A pass ends after a run of failures and a failed
// row stays owed, so in a fixed order a few rows Last.fm always refuses would
// sit at the front and end every pass before it reached the rest of the library.
export function selectTrackTagIds(opts: {
  reEnrich: boolean;
  limit: number;
  ids: string[];
  owed: string[];
  order?: (ids: string[]) => string[];
}): string[] {
  const order = opts.order ?? shuffle;
  const owed = new Set(opts.owed);
  const scope = opts.reEnrich
    ? order(opts.ids)
    : [...new Set([...order(opts.ids.filter(id => owed.has(id))), ...order(opts.owed)])];
  return opts.limit === Infinity ? scope : scope.slice(0, opts.limit);
}
