// Consistency check between track_facet_status and the analysis columns it
// shadows. Read-only. Two questions:
//
//   1. Rows: does every stored facet row match what deriveFacetRows() makes of
//      the track's columns today (status, attempts), with no orphans?
//   2. Scopes: does each facet's "needs work" set equal the legacy scope query
//      the analysis pass uses today (needsAnalysisIds, unanalysedAudioIds,
//      needsVocalIds with tail widening, needsStemsIds)?
//
// Both must come back empty before anything is allowed to plan from the facet
// table. Used by `npm run facets -- --check` and the facet tests.

import * as db from './library-db.js';

export interface FacetDrift {
  id: string;
  facet: db.Facet;
  stored: string; // "ok", "failed×2", "-" (no row)
  derived: string;
}

export interface ScopeDiff {
  facet: db.Facet;
  legacy: string; // which legacy query it was compared with
  legacyCount: number;
  facetCount: number;
  onlyLegacy: string[]; // sample ids (max 10)
  onlyFacet: string[];
  onlyLegacyCount: number;
  onlyFacetCount: number;
}

export interface FacetCheckReport {
  tracks: number;
  rows: number;
  orphans: number;
  drift: FacetDrift[];
  driftCount: number;
  scopes: ScopeDiff[];
  ok: boolean;
}

const label = (r: { status: string; attempts: number } | undefined) =>
  !r ? '-' : r.attempts > 0 ? `${r.status}×${r.attempts}` : r.status;

export function checkFacets(sample = 10): FacetCheckReport {
  const d = db.requireDb();
  const tracks = d
    .prepare(`SELECT id, ${db.FACET_SOURCE_SELECT} FROM tracks`)
    .all() as Array<db.FacetSourceRow & { id: string }>;
  const clap = new Set(
    (d.prepare('SELECT id FROM track_audio_vectors').all() as Array<{ id: string }>).map(r => r.id),
  );
  const stored = new Map<string, Map<string, { status: string; attempts: number }>>();
  let rows = 0;
  for (const r of d
    .prepare('SELECT track_id, facet, status, attempts FROM track_facet_status')
    .all() as Array<{ track_id: string; facet: string; status: string; attempts: number }>) {
    rows += 1;
    let m = stored.get(r.track_id);
    if (!m) stored.set(r.track_id, (m = new Map()));
    m.set(r.facet, { status: r.status, attempts: r.attempts });
  }

  const drift: FacetDrift[] = [];
  let driftCount = 0;
  const known = new Set<string>();
  for (const t of tracks) {
    known.add(t.id);
    const want = new Map(db.deriveFacetRows(t, clap.has(t.id)).map(r => [r.facet, r]));
    const have = stored.get(t.id) ?? new Map();
    for (const facet of db.FACETS) {
      const a = have.get(facet);
      const b = want.get(facet);
      // A tail's 'unmeasurable' reason depends on the pass that wrote it, so
      // status + attempts is the contract; reasons are informational.
      if (label(a) === label(b)) continue;
      driftCount += 1;
      if (drift.length < sample) drift.push({ id: t.id, facet, stored: label(a), derived: label(b) });
    }
  }
  const orphans = [...stored.keys()].filter(id => !known.has(id)).length;

  const legacy: Array<[db.Facet, string, () => string[]]> = [
    ['head', 'needsAnalysisIds()', () => db.needsAnalysisIds()],
    ['clap', 'unanalysedAudioIds()', () => db.unanalysedAudioIds()],
    ['vocal', 'needsVocalIds(tail widening)', () => db.needsVocalIds(undefined, true)],
    ['stems', 'needsStemsIds()', () => db.needsStemsIds()],
  ];
  const scopes: ScopeDiff[] = legacy.map(([facet, name, q]) => {
    const a = new Set(q());
    const b = new Set(db.facetNeedsIds(facet));
    const onlyLegacy = [...a].filter(id => !b.has(id));
    const onlyFacet = [...b].filter(id => !a.has(id));
    return {
      facet,
      legacy: name,
      legacyCount: a.size,
      facetCount: b.size,
      onlyLegacy: onlyLegacy.slice(0, sample),
      onlyFacet: onlyFacet.slice(0, sample),
      onlyLegacyCount: onlyLegacy.length,
      onlyFacetCount: onlyFacet.length,
    };
  });

  return {
    tracks: tracks.length,
    rows,
    orphans,
    drift,
    driftCount,
    scopes,
    ok: driftCount === 0 && orphans === 0 && scopes.every(s => s.onlyLegacyCount === 0 && s.onlyFacetCount === 0),
  };
}
