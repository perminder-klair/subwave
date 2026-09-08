// Stem-cache scan scope and its ordering — the SQL projection of
// `music/stem-priority.ts` (#1622 FR 14).
//
// The ranking RULE lives in that module: it is a policy reached from several
// call sites (the backfill scope here, the byte-budget sweep in
// music/stem-cache.ts) and it has to be readable and testable without a
// database. This file is the query that applies it. Every weight, window and
// eligibility rule is IMPORTED, never restated, and
// scripts/stem-priority.test.ts pins the two against each other row-for-row —
// the same discipline the era filter needs, because a JS scorer and a SQL
// scorer that quietly disagree pick different tracks and nothing says so.

import { requireDb } from './handle.js';
import { analysisFailureExclusion } from './tracks.js';
import {
  STEM_PRIORITY_WEIGHTS as W,
  stemPriorityWindows,
  type StemPriorityFacts,
} from '../stem-priority.js';

export interface StemScanOpts {
  // Track ids the OPERATOR hearted, and ids a listener liked. Injected rather
  // than read here: likes live in state/likes.json (broadcast/likes.ts) and
  // library-db is the bottom layer. Absent (the CLI tagger, a station with no
  // likes) simply drops the curation term — the scan still ranks on grids and
  // airplay, which is the fail-open direction.
  operatorLikedIds?: readonly string[];
  listenerLikedIds?: readonly string[];
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// The eligibility facts, in SQL
// ---------------------------------------------------------------------------
//
// Both mirror the gates in broadcast/stem-blend.ts `maybeRenderBlend`, read
// off the raw columns. json_valid() guards every json_* call — a malformed
// column would otherwise throw mid-scan and take the whole backfill with it —
// and the CASE is what makes that guard load-bearing, since SQLite does not
// promise to short-circuit an AND chain.
//
// One accepted approximation on each side: `rows.ts` drops non-finite entries
// when it parses these columns, so a grid that is entirely non-numeric counts
// as present here and as absent at the seam. It costs one wasted slot on a
// column no analyzer writes, and mirroring it would mean re-implementing
// parseMsArray in SQL.

// bars_json is a non-empty array → this track can be a seam's INCOMING side.
const SQL_HEAD_GRID = (t: string) => `
  (CASE WHEN ${t}.bars_json IS NOT NULL AND json_valid(${t}.bars_json)
        THEN (CASE WHEN COALESCE(json_array_length(${t}.bars_json), 0) > 0 THEN 1 ELSE 0 END)
        ELSE 0 END)`;

// outro_json is a parseable outro carrying a non-empty tail bar grid, and the
// track has a duration → it can be a seam's OUTGOING side. The `ending` /
// `startMs` checks are parseOutroJson's own validity rules: without them the
// row reads as tail-ready here while the seam maps it to `outro: null`.
const SQL_TAIL_GRID = (t: string) => `
  (CASE WHEN ${t}.outro_json IS NOT NULL AND json_valid(${t}.outro_json)
             AND COALESCE(${t}.duration_sec, 0) > 0
        THEN (CASE WHEN COALESCE(json_array_length(${t}.outro_json, '$.bars'), 0) > 0
                    AND json_extract(${t}.outro_json, '$.ending') IN ('fade','cold')
                    AND COALESCE(json_extract(${t}.outro_json, '$.startMs'), -1) >= 0
                   THEN 1 ELSE 0 END)
        ELSE 0 END)`;

// ---------------------------------------------------------------------------
// The score, in SQL
// ---------------------------------------------------------------------------

// Aggregated play history for the two windows the policy asks about. One pass
// over `plays` on idx_plays_track_played, joined once — never a correlated
// subquery per candidate, which on a 55k library is 55k index probes.
const PLAYS_JOIN = (t: string, p: string) => `
  LEFT JOIN (
    SELECT track_id,
           SUM(CASE WHEN played_at >= :stemRecentSince THEN 1 ELSE 0 END) AS recent_n,
           MAX(played_at) AS last_at
      FROM plays
     WHERE track_id IS NOT NULL AND track_id != ''
     GROUP BY track_id
  ) ${p} ON ${p}.track_id = ${t}.id`;

// A liked-id set arrives as one JSON array parameter, so the statement text is
// the same whatever the list length (no rebuilding a 2000-placeholder IN, no
// SQLITE_MAX_VARIABLE_NUMBER to think about). An EMPTY list emits the constant
// 0 instead — the clause costs nothing on a station with no likes, which is
// most of them.
function likeTerm(t: string, param: string, weight: number, ids: readonly string[] | undefined): string {
  if (!ids || ids.length === 0) return '0';
  return `(CASE WHEN ${t}.id IN (SELECT value FROM json_each(:${param})) THEN ${weight} ELSE 0 END)`;
}

interface BuiltPriority {
  expr: string;
  join: string;
  params: Record<string, string>;
}

// The whole score as one SQL expression over the tracks alias `t` and the
// plays aggregate alias `p`. Structurally identical to `stemPriority()`:
// seam sides MULTIPLY the value sum, so zero sides is zero.
function buildPriority(opts: StemScanOpts, t = 't', p = 'p'): BuiltPriority {
  const operatorIds = dedupe(opts.operatorLikedIds);
  const listenerIds = dedupe(opts.listenerLikedIds);
  const windows = stemPriorityWindows(opts.nowMs ?? Date.now());
  const params: Record<string, string> = {
    stemRecentSince: windows.recentSince,
    stemHotSince: windows.hotSince,
  };
  if (operatorIds.length) params.stemOperatorIds = JSON.stringify(operatorIds);
  if (listenerIds.length) params.stemListenerIds = JSON.stringify(listenerIds);
  const expr = `(
    (${SQL_HEAD_GRID(t)} + ${SQL_TAIL_GRID(t)}) * (
      ${W.base}
      + ${likeTerm(t, 'stemOperatorIds', W.operatorHeart, operatorIds)}
      + ${likeTerm(t, 'stemListenerIds', W.listenerLike, listenerIds)}
      + ${W.perRecentPlay} * MIN(COALESCE(${p}.recent_n, 0), ${W.recentPlayCap})
      + (CASE WHEN COALESCE(${p}.last_at, '') >= :stemHotSince THEN ${W.airedRecently} ELSE 0 END)
      + (CASE WHEN ${p}.last_at IS NOT NULL THEN ${W.everAired} ELSE 0 END)
    )
  )`;
  return { expr, join: PLAYS_JOIN(t, p), params };
}

function dedupe(ids: readonly string[] | undefined): string[] {
  if (!ids || ids.length === 0) return [];
  return [...new Set(ids.map(String).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

// Ids that have never had a stem-caching pass (feature: stem backfill), so
// turning the stem cache on for an already-analysed library fills it in
// without the destructive, non-resumable --re-analyze that was the only path
// before. Independent of the bpm/key scope, like unanalysedAudioIds and
// needsVocalIds.
//
// stems_at stamps the ATTEMPT, not disk presence — see the migration-17 note.
// That is what makes this converge: the LRU sweep evicts stem dirs whenever
// the cache outgrows its budget, and a presence-based scope would drag every
// evicted track back in on the next pass, forever, on any library bigger than
// the budget.
//
// ORDERED BY PRIORITY, and the tiebreak is RANDOM() rather than id (#1622).
// The budget always binds on a real library, so this order IS which tracks get
// stems; `ORDER BY id` over Navidrome's opaque hashes spent it by lottery and
// spent it on the same losers every night. Resumption does not depend on the
// order — the stems_at stamp is what a resumed pass reads — so the order is
// free to be a ranking, and free to redraw its enormous tie class each pass so
// no track is permanently behind the cut. See music/stem-priority.ts.
export function needsStemsIds(limit?: number, opts: StemScanOpts = {}): string[] {
  const { expr, join, params } = buildPriority(opts);
  const sql =
    `SELECT t.id FROM tracks t${join}
      WHERE t.stems_at IS NULL AND ${analysisFailureExclusion('t')}
      ORDER BY ${expr} DESC, RANDOM()` +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(sql).all(params) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// The same score for ids that are ALREADY cached — what the byte-budget sweep
// evicts against (music/stem-cache.ts). Ids missing from the catalogue are
// simply absent from the map; the caller decides what an orphan dir is worth
// (stem-priority.UNKNOWN_TRACK_PRIORITY).
export function stemPriorityIndex(
  ids: readonly string[],
  opts: StemScanOpts = {},
): Map<string, number> {
  const out = new Map<string, number>();
  const wanted = dedupe(ids);
  if (wanted.length === 0) return out;
  const { expr, join, params } = buildPriority(opts);
  const rows = requireDb()
    .prepare(
      `SELECT t.id AS id, ${expr} AS priority FROM tracks t${join}
        WHERE t.id IN (SELECT value FROM json_each(:stemWantedIds))`,
    )
    .all({ ...params, stemWantedIds: JSON.stringify(wanted) }) as Array<{
      id: string;
      priority: number;
    }>;
  for (const r of rows) out.set(r.id, Number(r.priority) || 0);
  return out;
}

// The facts behind one track's score, straight off the raw columns — the JS
// half of the agreement the test pins. Production reads the SQL expression;
// this exists so the two can be compared on the same row.
export function stemPriorityFactsFor(
  ids: readonly string[],
  opts: StemScanOpts = {},
): Map<string, StemPriorityFacts> {
  const out = new Map<string, StemPriorityFacts>();
  const wanted = dedupe(ids);
  if (wanted.length === 0) return out;
  const operator = new Set(dedupe(opts.operatorLikedIds));
  const listener = new Set(dedupe(opts.listenerLikedIds));
  const windows = stemPriorityWindows(opts.nowMs ?? Date.now());
  const rows = requireDb()
    .prepare(
      `SELECT t.id AS id, t.bars_json AS bars_json, t.outro_json AS outro_json,
              t.duration_sec AS duration_sec, p.recent_n AS recent_n, p.last_at AS last_at
         FROM tracks t${PLAYS_JOIN('t', 'p')}
        WHERE t.id IN (SELECT value FROM json_each(:stemWantedIds))`,
    )
    .all({
      stemRecentSince: windows.recentSince,
      stemWantedIds: JSON.stringify(wanted),
    }) as Array<{
      id: string;
      bars_json: string | null;
      outro_json: string | null;
      duration_sec: number | null;
      recent_n: number | null;
      last_at: string | null;
    }>;
  for (const r of rows) {
    out.set(r.id, {
      hasHeadGrid: jsonArrayLength(r.bars_json) > 0,
      hasTailGrid:
        (r.duration_sec ?? 0) > 0 && outroTailBars(r.outro_json),
      recentPlays: r.recent_n ?? 0,
      everAired: r.last_at != null,
      airedRecently: (r.last_at ?? '') >= windows.hotSince,
      operatorHeart: operator.has(r.id),
      listenerLiked: listener.has(r.id),
    });
  }
  return out;
}

function jsonArrayLength(s: string | null): number {
  if (!s) return 0;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

function outroTailBars(s: string | null): boolean {
  if (!s) return false;
  try {
    const v = JSON.parse(s) as Record<string, unknown>;
    if (!Array.isArray(v?.bars) || v.bars.length === 0) return false;
    if (v.ending !== 'fade' && v.ending !== 'cold') return false;
    const startMs = Number(v.startMs);
    return Number.isFinite(startMs) && startMs >= 0;
  } catch {
    return false;
  }
}
