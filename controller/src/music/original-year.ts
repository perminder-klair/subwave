// The year facet's runner: ask MusicBrainz for each track's original year and
// record the outcome (library-db recordOriginalYearOutcome). Shared by the
// tagger's enrichment phase, Reconcile and `npm run analyze -- --facets year`.
// The rules (what an answer means, when a failed lookup is retried) are in
// music/original-year-policy.ts; which tracks are due is the year facet row
// (library-db/facets.ts yearLookupDueIds).

import * as subsonic from './subsonic.js';
import * as musicbrainz from './musicbrainz.js';
import * as db from './library-db.js';
import { reportProgress } from './tagger-progress.js';
import { mapPool } from '../util/async-pool.js';

export interface YearPassStats {
  asked: number;
  found: number;
  notFound: number;
  errors: number;
}

// Effectively serial whatever the pool width: MusicBrainz throttles to 1 req/s
// (musicbrainz.ts). `force` re-asks a track already answered "not found" (an
// explicit `--where unmeasurable` / `--where all` run, or a `--re-enrich` miss
// inside the run's scope); a resolved or manual year is never re-asked.
export async function runYearLookups(
  ids: readonly string[],
  opts: { force?: boolean; concurrency?: number; label?: string } = {},
): Promise<YearPassStats> {
  const stats: YearPassStats = { asked: 0, found: 0, notFound: 0, errors: 0 };
  if (!ids.length) return stats;
  const label = opts.label ?? '[tag]';
  console.log(`${label} original years: ${ids.length} era-suspect tracks to resolve via MusicBrainz (~1/s)`);
  reportProgress({ phase: 'enrich', label: 'Resolving original years', done: 0, total: ids.length });
  await mapPool([...ids], Math.max(1, Math.min(opts.concurrency ?? 4, 4)), async (id) => {
    const t = db.getTrack(id);
    if (!t || !musicbrainz.needsOriginalYearLookup(t, opts.force === true)) return;
    let mbid: string | null = null;
    try {
      mbid = (await subsonic.getSong(id))?.musicBrainzId || null;
    } catch { /* MBID is optional — the search path covers it */ }
    const outcome = await musicbrainz.lookupOriginalYear({ title: t.title, artist: t.artist, mbid, year: t.year });
    db.recordOriginalYearOutcome(id, outcome);
    stats.asked += 1;
    if (outcome.kind === 'found') stats.found += 1;
    else if (outcome.kind === 'not-found') stats.notFound += 1;
    else stats.errors += 1;
    if (stats.asked % 25 === 0) {
      console.log(`${label} original years ${stats.asked}/${ids.length} (${stats.found} resolved, ${stats.errors} errors)`);
      reportProgress({ phase: 'enrich', label: 'Resolving original years', done: stats.asked, total: ids.length });
    }
  });
  console.log(
    `${label} original years done: ${stats.found} found, ${stats.notFound} not found, ${stats.errors} errors` +
      (stats.errors ? ' (retried later: 1 h, 1 day, then 7 days)' : ''),
  );
  return stats;
}
