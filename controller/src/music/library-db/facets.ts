// Per-facet analysis status: which parts of a track's acoustic analysis exist,
// at which version, and why a missing one is missing. A shadow of the analysis
// columns on `tracks` for now — every row here is DERIVED from those columns
// (deriveFacetRows), so the two can't disagree. Nothing reads this table to
// decide what to analyse yet; the facet planner will.
//
// Why a separate table: one ANALYSIS_VERSION on `tracks` marks a track done for
// every feature at once, so a track whose download was too large to reach its
// tail is never retried, and bumping the version to fix one feature redoes all
// of them. Here each facet has its own version and status, so bumping one
// facet's version re-targets exactly that facet.
//
// Facets (what each one writes on `tracks`):
//   head      bpm, key, key ranges, intro, lead silence, sections, pace, grid
//   loudness  loudness_lufs, peak_db
//   tail      outro_json, tail_silence_ms, tail_start_ms
//   clap      the CLAP audio vector (track_audio_vectors)
//   vocal     vocal_ranges_json (+ the outro's tail vocal ranges)
//   stems     stems_at (the stem-cache attempt stamp)
//
// Status: 'ok' = measured; 'unmeasurable' = attempted, and this version can't
// measure it for this file (terminal until the version is bumped); 'failed' =
// the track's analysis failed, `attempts` mirrors analyze_fail_count. No row =
// never attempted.
//
// The table lives OUTSIDE the PRAGMA user_version chain on purpose: it is
// created idempotently on every open (like track_audio_vectors), so it never
// takes a migration number from upstream's sequence. A one-row companion,
// track_facet_meta, records the ANALYSIS_VERSION and FACET_VERSIONS the rows
// were last derived under; when either constant changes, the next open
// re-derives every track (ensureFacetStatus), because head/loudness/tail are
// read off analysis_version and would otherwise drift without any write.

import type Database from 'better-sqlite3';
import { ANALYSIS_VERSION, requireDb } from './handle.js';

export const FACETS = ['head', 'loudness', 'tail', 'clap', 'vocal', 'stems'] as const;
export type Facet = (typeof FACETS)[number];
export type FacetStatus = 'ok' | 'unmeasurable' | 'failed';

// Bump ONE entry to re-target exactly that facet. Rows written by an older
// version keep their version, so facetNeedsIds() picks them up again.
// vocal v1 = head AND tail vocal ranges; a head-only row is stored at v0.
export const FACET_VERSIONS: Readonly<Record<Facet, number>> = {
  head: 1,
  loudness: 1,
  tail: 1,
  clap: 1,
  vocal: 1,
  stems: 1,
};

// Same limit as analyze_fail_count (tracks.ts MAX_ANALYSIS_FAILURES); kept as
// its own constant so this module only depends on handle.ts.
export const FACET_MAX_ATTEMPTS = 3;

// Where the analysed audio came from, as far as the controller knows.
export type FacetSource = 'seed' | 'full' | 'capped' | 'unknown' | 'url' | 'analyzer';

// What a facet status is derived from: the `tracks` columns, reduced to flags
// in SQL (FACET_SOURCE_SELECT) so the seed never loads the JSON payloads.
export interface FacetSourceRow {
  analysis_version: number | null;
  has_loudness: number;      // loudness_lufs IS NOT NULL
  has_tail_silence: number;  // tail_silence_ms IS NOT NULL
  has_outro: number;         // outro_json IS NOT NULL
  outro_has_vocals: number;  // outro_json carries a "vocalRanges" key
  has_vocal: number;         // vocal_ranges_json IS NOT NULL ('[]' = instrumental, counts)
  has_stems: number;         // stems_at IS NOT NULL
  analyze_fail_count: number | null;
  analyze_error: string | null;
}

export const FACET_SOURCE_SELECT =
  `analysis_version,
   loudness_lufs IS NOT NULL                          AS has_loudness,
   tail_silence_ms IS NOT NULL                        AS has_tail_silence,
   outro_json IS NOT NULL                             AS has_outro,
   COALESCE(instr(outro_json, '"vocalRanges"'), 0) > 0 AS outro_has_vocals,
   vocal_ranges_json IS NOT NULL                      AS has_vocal,
   stems_at IS NOT NULL                               AS has_stems,
   analyze_fail_count, analyze_error`;

export interface DerivedFacet {
  facet: Facet;
  status: FacetStatus;
  version: number;
  reason: string | null;
  attempts: number;
}

export interface DeriveOpts {
  // How an unmeasured tail is explained (a capped download can't reach it).
  tailReason?: string;
}

// The one place a facet status is decided. Pure: same row in, same rows out —
// shared by the seed, every live write and the consistency check.
export function deriveFacetRows(
  row: FacetSourceRow,
  hasClap: boolean,
  opts: DeriveOpts = {},
): DerivedFacet[] {
  const out: DerivedFacet[] = [];
  const ok = (facet: Facet, reason: string | null = null, version = FACET_VERSIONS[facet]) =>
    out.push({ facet, status: 'ok', version, reason, attempts: 0 });
  const unmeasurable = (facet: Facet, reason: string) =>
    out.push({ facet, status: 'unmeasurable', version: FACET_VERSIONS[facet], reason, attempts: 0 });

  // The head pass is what stamps analysis_version; an older stamp means the
  // head features predate the current shape and are due again.
  const analysed = row.analysis_version === ANALYSIS_VERSION;
  if (analysed) ok('head');

  if (row.has_loudness) ok('loudness');
  else if (analysed) unmeasurable('loudness', 'not-measured');

  // An outro proves the tail was decoded, even when its window held no
  // silence edge (tail_silence_ms is then NULL by design).
  if (row.has_tail_silence || row.has_outro) ok('tail');
  else if (analysed) unmeasurable('tail', opts.tailReason ?? 'tail-not-measured');

  if (hasClap) ok('clap');

  if (row.has_vocal) {
    // Mirrors needsVocalIds(includeTailMissing): an outro without tail vocal
    // ranges is head-only — stored one version below current so it stays due.
    const headOnly = !!row.has_outro && !row.outro_has_vocals;
    if (headOnly) ok('vocal', 'head-only', FACET_VERSIONS.vocal - 1);
    else ok('vocal');
  }

  if (row.has_stems) ok('stems');

  // A failed analysis counts against every facet it would have produced.
  const fails = row.analyze_fail_count ?? 0;
  if (fails > 0) {
    const have = new Set(out.map(r => r.facet));
    for (const facet of FACETS) {
      if (have.has(facet)) continue;
      out.push({
        facet,
        status: 'failed',
        version: FACET_VERSIONS[facet],
        reason: (row.analyze_error || 'analysis failed').slice(0, 500),
        attempts: fails,
      });
    }
  }
  return out;
}

interface StoredFacet {
  facet: Facet;
  status: FacetStatus;
  version: number;
  reason: string | null;
  attempts: number;
  source: string | null;
}

export interface SyncOpts extends DeriveOpts {
  // Facets this write actually (re)measured: they take the current version.
  // Any other facet keeps the version it was measured at, so a re-sync never
  // promotes old data past a version bump.
  fresh?: readonly Facet[];
  // Facets this write ATTEMPTED without necessarily storing a result (a tail
  // the pass decoded but could not measure, or could not reach on a capped
  // download). When the derived status is 'unmeasurable' the attempt itself is
  // the answer at the current version, so it counts as fresh; when it is 'ok'
  // (an earlier measurement kept by COALESCE) the row keeps its own version.
  // Without this a version bump never settles for a still-unmeasurable track.
  tried?: readonly Facet[];
  source?: FacetSource;
}

// Re-derive one track's facet rows from its columns and store the difference.
// Unchanged rows are left alone (their `at` stays the time of the last change).
// Callers run it inside the same transaction as the column write it mirrors.
export function syncTrackFacets(id: string, opts: SyncOpts = {}): void {
  syncTrackFacetsOn(requireDb(), id, opts);
}

function syncTrackFacetsOn(d: Database.Database, id: string, opts: SyncOpts): void {
  const row = d.prepare(`SELECT ${FACET_SOURCE_SELECT} FROM tracks WHERE id = ?`).get(id) as
    | FacetSourceRow
    | undefined;
  if (!row) {
    d.prepare('DELETE FROM track_facet_status WHERE track_id = ?').run(id);
    return;
  }
  const hasClap = !!d.prepare('SELECT 1 FROM track_audio_vectors WHERE id = ? LIMIT 1').get(id);
  const derived = deriveFacetRows(row, hasClap, opts);
  const stored = new Map(
    (d
      .prepare('SELECT facet, status, version, reason, attempts, source FROM track_facet_status WHERE track_id = ?')
      .all(id) as StoredFacet[]).map(r => [r.facet, r]),
  );
  const fresh = new Set(opts.fresh ?? []);
  const tried = new Set(opts.tried ?? []);
  const now = new Date().toISOString();
  const upsert = d.prepare(
    `INSERT INTO track_facet_status (track_id, facet, version, status, reason, attempts, source, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(track_id, facet) DO UPDATE SET
       version = excluded.version, status = excluded.status, reason = excluded.reason,
       attempts = excluded.attempts, source = excluded.source, at = excluded.at`,
  );
  for (const r of derived) {
    const prev = stored.get(r.facet);
    stored.delete(r.facet);
    const isFresh = fresh.has(r.facet) || (tried.has(r.facet) && r.status === 'unmeasurable');
    // An unmeasurable/ok row's reason describes the pass that measured it
    // ('capped-download' vs 'tail-not-measured'); a re-sync that didn't
    // re-measure the facet keeps it. A failure's reason is the latest error.
    if (!isFresh && prev && prev.status === r.status && r.status !== 'failed') r.reason = prev.reason;
    const version =
      isFresh || !prev || prev.status !== r.status ? r.version : Math.min(prev.version, r.version);
    // 'seed' is reserved for rows the seed wrote; a live write that creates a
    // row without measuring it (a failure, a re-derive) records what it knows.
    const source = isFresh ? (opts.source ?? 'unknown') : (prev?.source ?? opts.source ?? null);
    if (
      prev &&
      !isFresh &&
      prev.status === r.status &&
      prev.version === version &&
      prev.reason === r.reason &&
      prev.attempts === r.attempts
    ) {
      continue;
    }
    upsert.run(id, r.facet, version, r.status, r.reason, r.attempts, source, now);
  }
  // Whatever the columns no longer support (cleared, or a failure wiped by a
  // success) goes: no row = not done.
  const del = d.prepare('DELETE FROM track_facet_status WHERE track_id = ? AND facet = ?');
  for (const facet of stored.keys()) del.run(id, facet);
}

// The versions the stored rows were derived under. A change to either one
// re-derives the table on the next open.
export function facetDerivationStamp(): string {
  return JSON.stringify({ analysis: ANALYSIS_VERSION, facets: FACET_VERSIONS });
}

function readFacetStamp(d: Database.Database): string | null {
  const row = d.prepare('SELECT stamp FROM track_facet_meta WHERE pk = 1').get() as { stamp: string } | undefined;
  return row?.stamp ?? null;
}

function writeFacetStamp(d: Database.Database): void {
  d.prepare(
    `INSERT INTO track_facet_meta (pk, stamp) VALUES (1, ?)
     ON CONFLICT(pk) DO UPDATE SET stamp = excluded.stamp`,
  ).run(facetDerivationStamp());
}

// Re-derive every track's rows through the same path a live write uses, so
// reasons, sources and per-facet versions survive (a drop-and-reseed would
// lose them). Rows whose track is gone are dropped first. Returns tracks synced.
export function resyncAllFacets(d: Database.Database): number {
  let synced = 0;
  d.transaction(() => {
    d.prepare('DELETE FROM track_facet_status WHERE track_id NOT IN (SELECT id FROM tracks)').run();
    const ids = (d.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map(r => r.id);
    for (const id of ids) {
      syncTrackFacetsOn(d, id, {});
      synced += 1;
    }
    writeFacetStamp(d);
  })();
  return synced;
}

// Create the table if absent and seed it from the columns the first time; on
// an existing table, re-derive it when ANALYSIS_VERSION or FACET_VERSIONS have
// changed since it was last derived. Idempotent; called on every open from
// migrate(). Returns rows seeded (0 when the table already existed).
export function ensureFacetStatus(d: Database.Database): number {
  d.exec(`CREATE TABLE IF NOT EXISTS track_facet_meta (
    pk    INTEGER PRIMARY KEY CHECK (pk = 1),
    stamp TEXT NOT NULL
  )`);
  const exists = d
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='track_facet_status'`)
    .get();
  if (exists) {
    // An unchanged stamp means every row is still derived under the current
    // versions: nothing to do, and no per-open scan of the table. A missing
    // stamp (a table created before the meta row existed) re-derives once.
    if (readFacetStamp(d) === facetDerivationStamp()) return 0;
    const t0 = Date.now();
    const n = resyncAllFacets(d);
    console.log(`[library-db] track_facet_status re-derived for ${n} tracks (analysis/facet versions changed, ${Date.now() - t0} ms)`);
    return 0;
  }
  let seeded = 0;
  d.transaction(() => {
    d.exec(`
      CREATE TABLE track_facet_status (
        track_id  TEXT    NOT NULL,
        facet     TEXT    NOT NULL,
        version   INTEGER NOT NULL,
        status    TEXT    NOT NULL CHECK (status IN ('ok','unmeasurable','failed')),
        reason    TEXT,
        attempts  INTEGER NOT NULL DEFAULT 0,
        source    TEXT,
        at        TEXT    NOT NULL,
        PRIMARY KEY (track_id, facet)
      ) WITHOUT ROWID;
      CREATE INDEX idx_facet_status ON track_facet_status(facet, status, version);
    `);
    const hasAudioVec = !!d
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='track_audio_vectors'`)
      .get();
    const clapIds = new Set(
      hasAudioVec
        ? (d.prepare('SELECT id FROM track_audio_vectors').all() as Array<{ id: string }>).map(r => r.id)
        : [],
    );
    const insert = d.prepare(
      `INSERT INTO track_facet_status (track_id, facet, version, status, reason, attempts, source, at)
       VALUES (?, ?, ?, ?, ?, ?, 'seed', ?)`,
    );
    const now = new Date().toISOString();
    // .all(), not .iterate(): better-sqlite3 refuses writes on a connection
    // with an open iterator. The flags keep this to a few MB on 80k tracks.
    const rows = d.prepare(`SELECT id, ${FACET_SOURCE_SELECT} FROM tracks`).all() as Array<
      FacetSourceRow & { id: string }
    >;
    for (const row of rows) {
      for (const r of deriveFacetRows(row, clapIds.has(row.id))) {
        insert.run(row.id, r.facet, r.version, r.status, r.reason, r.attempts, now);
        seeded += 1;
      }
    }
    writeFacetStamp(d);
  })();
  console.log(`[library-db] track_facet_status created and seeded (${seeded} rows)`);
  return seeded;
}

// Move a rotated id's rows onto its new id (id adoption). The new id's own rows
// win; the caller re-derives afterwards from the merged columns.
export function moveFacetRows(oldId: string, newId: string): void {
  const d = requireDb();
  d.prepare(
    `INSERT OR IGNORE INTO track_facet_status (track_id, facet, version, status, reason, attempts, source, at)
     SELECT ?, facet, version, status, reason, attempts, source, at
       FROM track_facet_status WHERE track_id = ?`,
  ).run(newId, oldId);
  d.prepare('DELETE FROM track_facet_status WHERE track_id = ?').run(oldId);
}

export function deleteFacetRows(id: string): void {
  requireDb().prepare('DELETE FROM track_facet_status WHERE track_id = ?').run(id);
}

// Mirror of clearAnalysis(): drop what it clears, plus every failure.
export function clearFacetRows(opts: { keepVocal?: boolean; clearStems?: boolean } = {}): void {
  const facets: Facet[] = ['head', 'loudness', 'tail', 'clap'];
  if (!opts.keepVocal) facets.push('vocal');
  if (opts.clearStems) facets.push('stems');
  const d = requireDb();
  d.prepare(
    `DELETE FROM track_facet_status
      WHERE facet IN (${facets.map(() => '?').join(',')}) OR status = 'failed'`,
  ).run(...facets);
  // A kept vocal row was "head-only" because the outro lacked tail vocals; the
  // outro is gone now, so the same rule (deriveFacetRows) no longer holds it due.
  if (opts.keepVocal) {
    d.prepare(
      `UPDATE track_facet_status SET version = ?, reason = NULL
        WHERE facet = 'vocal' AND reason = 'head-only'`,
    ).run(FACET_VERSIONS.vocal);
  }
}

// Mirror of clearAnalysisFailures(): a cleared history means "not attempted".
export function clearFacetFailures(id?: string): void {
  const d = requireDb();
  if (id) d.prepare(`DELETE FROM track_facet_status WHERE status = 'failed' AND track_id = ?`).run(id);
  else d.prepare(`DELETE FROM track_facet_status WHERE status = 'failed'`).run();
}

// Tracks with work for `facet`: never attempted, measured by an older version,
// or failed fewer than FACET_MAX_ATTEMPTS times. Ordered for stable resumption.
export function facetNeedsIds(facet: Facet, limit?: number): string[] {
  const sql =
    `SELECT t.id FROM tracks t
       LEFT JOIN track_facet_status s ON s.track_id = t.id AND s.facet = ?
      WHERE s.track_id IS NULL
         OR s.version < ?
         OR (s.status = 'failed' AND s.attempts < ?)
      ORDER BY t.id` + (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  return (
    requireDb().prepare(sql).all(facet, FACET_VERSIONS[facet], FACET_MAX_ATTEMPTS) as Array<{ id: string }>
  ).map(r => r.id);
}

export interface FacetCount {
  facet: Facet;
  total: number;
  ok: number;
  unmeasurable: number;
  failed: number;
  missing: number;
  outdated: number;
  needs: number;
}

// Per-facet counts for the coverage preview and the consistency check.
export function facetCounts(): FacetCount[] {
  const d = requireDb();
  const total = (d.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
  const stmt = d.prepare(
    `SELECT
       SUM(status = 'ok')           AS ok,
       SUM(status = 'unmeasurable') AS unmeasurable,
       SUM(status = 'failed')       AS failed,
       SUM(version < ?)             AS outdated,
       SUM(version < ? OR (status = 'failed' AND attempts < ?)) AS dueRows,
       COUNT(*)                     AS rows
     FROM track_facet_status WHERE facet = ?`,
  );
  return FACETS.map((facet) => {
    const v = FACET_VERSIONS[facet];
    const r = stmt.get(v, v, FACET_MAX_ATTEMPTS, facet) as Record<string, number | null>;
    const rows = r.rows ?? 0;
    const missing = total - rows;
    return {
      facet,
      total,
      ok: r.ok ?? 0,
      unmeasurable: r.unmeasurable ?? 0,
      failed: r.failed ?? 0,
      missing,
      outdated: r.outdated ?? 0,
      needs: missing + (r.dueRows ?? 0),
    };
  });
}

// One stored facet row, as the planner (music/acoustics-plan.ts) reads it.
export interface FacetCell {
  status: FacetStatus;
  version: number;
  attempts: number;
  reason: string | null;
}

// Stored rows for `facets`, keyed by track then facet. Tracks with no row for
// a facet are simply absent from that inner map (= never attempted).
export function loadFacetState(facets: readonly Facet[]): Map<string, Map<Facet, FacetCell>> {
  const out = new Map<string, Map<Facet, FacetCell>>();
  if (facets.length === 0) return out;
  const rows = requireDb()
    .prepare(
      `SELECT track_id, facet, status, version, attempts, reason FROM track_facet_status
        WHERE facet IN (${facets.map(() => '?').join(',')})`,
    )
    .all(...facets) as Array<FacetCell & { track_id: string; facet: Facet }>;
  for (const r of rows) {
    let m = out.get(r.track_id);
    if (!m) out.set(r.track_id, (m = new Map()));
    m.set(r.facet, { status: r.status, version: r.version, attempts: r.attempts, reason: r.reason });
  }
  return out;
}

// Every catalogued track id, in the stable order the passes resume in.
export function allTrackIdsOrdered(): string[] {
  return (requireDb().prepare('SELECT id FROM tracks ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
}
