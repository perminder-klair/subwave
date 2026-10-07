// Before pruning, move derived data and vectors to a different canonical ID only when the walk
// confirms that ID exists. Deleted tracks and unchanged canonical IDs still prune normally.
// #5824.

import { requireDb } from './handle.js';
import { canonicalId } from '../id-canonical.js';

// Carry physical track columns by default, excluding ID/generated columns and walk-owned
// metadata. columnPlan and the drift test require every column to be classified.
// scripts/id-adoption-columns.test.ts.
const NEVER_WRITTEN = ['id', 'genre'];

// Re-derived by the walk on every sync (upsertTrackMeta), so the freshly
// inserted row's copy is the current truth and adoption must leave it alone.
// original_year / original_year_source are walk-written too but are NOT here —
// they need the precedence rule below, not a blanket "new wins".
const WALK_OWNED = [
  'title', 'artist', 'album', 'album_id', 'artist_id', 'year',
  'genres', 'duration_sec', 'is_compilation', 'era_untrusted',
];

// Carry each writer's column group atomically unless the new row has its anchor. Analysis
// failure counters follow analysis_version so successful new analysis does not inherit old
// failures.
const GROUPS: Array<{ anchor: string; cols: string[] }> = [
  { anchor: 'enriched_at', cols: ['lastfm_tags', 'lyric_excerpt', 'enriched_at'] },
  { anchor: 'moods', cols: ['moods', 'energy', 'source', 'confidence', 'tagger_version', 'prompt_hash', 'model', 'tagged_at'] },
  {
    anchor: 'analysis_version',
    cols: ['bpm', 'musical_key', 'intro_ms', 'analysis_confidence', 'analysis_version', 'loudness_lufs',
      'peak_db', 'structure_json', 'pace_json', 'beats_json', 'bars_json', 'key_ranges_json',
      'lead_silence_ms', 'analyze_error', 'analyze_failed_at', 'analyze_fail_count'],
  },
  { anchor: 'audio_moods', cols: ['audio_moods', 'audio_mood_scores_json'] },
  { anchor: 'map_x', cols: ['map_x', 'map_y'] },
];

// Columns whose value can't be decided by "is it null" alone. Each is handled
// explicitly in mergeRow(); listed here so columnPlan() can account for them.
const SPECIAL = ['original_year', 'original_year_source', 'text_vector_dirty'];

// Default carried values to new ?? old. This list documents an explicit choice for columnPlan;
// unlisted carried columns use the same behavior.
const COALESCE_COLS = [
  'original_year_checked_at', 'vocal_ranges_json', 'outro_json', 'stems_at',
  'tail_silence_ms', 'tail_start_ms',
];

type Row = Record<string, unknown>;

export interface ColumnPlan {
  /** Physical columns of `tracks`, in table order. */
  all: string[];
  /** Left to the freshly-walked row. */
  walkOwned: string[];
  /** Carried under an anchor, filtered to columns the table actually has. */
  grouped: Array<{ anchor: string; cols: string[] }>;
  /** Carried under a bespoke rule in mergeRow(). */
  special: string[];
  /** Carried as `new ?? old`. */
  coalesced: string[];
  /** Carried by the COALESCE default because no rule names them. Must be
   *  empty: the behaviour is safe, but an unclassified column means nobody
   *  decided whether the walk owns it. */
  unclassified: string[];
  /** Named by a rule but absent from the table — a rename or a dropped column
   *  that would silently stop being carried. Must be empty. */
  missing: string[];
}

// Live column names, in table order. PRAGMA table_info omits VIRTUAL generated
// columns, which is why `genre` never appears; NEVER_WRITTEN guards the case
// where one is made STORED.
function physicalColumns(): string[] {
  const rows = requireDb().pragma('table_info(tracks)') as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function columnPlan(): ColumnPlan {
  const all = physicalColumns();
  const present = new Set(all);
  const named = new Set<string>([
    ...NEVER_WRITTEN, ...WALK_OWNED, ...SPECIAL, ...COALESCE_COLS,
    ...GROUPS.flatMap((g) => g.cols),
  ]);

  const grouped = GROUPS
    .map((g) => ({ anchor: g.anchor, cols: g.cols.filter((c) => present.has(c)) }))
    .filter((g) => g.cols.length > 0 && present.has(g.anchor));
  const groupedCols = new Set(grouped.flatMap((g) => g.cols));
  const skip = new Set([...NEVER_WRITTEN, ...WALK_OWNED]);

  const coalesced = all.filter(
    (c) => !skip.has(c) && !groupedCols.has(c) && !SPECIAL.includes(c),
  );

  return {
    all,
    walkOwned: WALK_OWNED.filter((c) => present.has(c)),
    grouped,
    special: SPECIAL.filter((c) => present.has(c)),
    coalesced,
    unclassified: all.filter((c) => !named.has(c)),
    missing: [...named].filter((c) => !present.has(c) && c !== 'genre'),
  };
}

// The ordered column list the carry UPDATE writes, and the merge that produces
// its values. Split out so the statement is prepared once per adoption run.
function carriedColumns(plan: ColumnPlan): string[] {
  return [...plan.grouped.flatMap((g) => g.cols), ...plan.coalesced, ...plan.special];
}

function mergeRow(plan: ColumnPlan, oldRow: Row, newRow: Row, movedTextVector: boolean): Row {
  const merged: Row = {};
  for (const g of plan.grouped) {
    const take = newRow[g.anchor] == null;
    for (const c of g.cols) merged[c] = take ? oldRow[c] : newRow[c];
  }
  for (const c of plan.coalesced) merged[c] = newRow[c] ?? oldRow[c];

  // Mirror upsertTrackMeta's precedence: a per-track 'musicbrainz' or 'manual'
  // resolution on the old row outranks the walk-time album-tag year the new
  // row just got. 'manual' is the operator reading the sleeve (#1418) and
  // outranks both, so it must not be dropped here either.
  const resolved = oldRow.original_year_source === 'musicbrainz' || oldRow.original_year_source === 'manual';
  const oldWins = resolved || newRow.original_year == null;
  merged.original_year = oldWins ? oldRow.original_year : newRow.original_year;
  merged.original_year_source = oldWins ? oldRow.original_year_source : newRow.original_year_source;

  // text_vector_dirty is NOT NULL DEFAULT 0, so the null-anchor and COALESCE
  // rules both read a fresh row's 0 as a real answer and would drop the marker.
  // It describes the VECTOR, so it follows the vector: carried only when the
  // old row's embedding was the one moved across. Otherwise the new row keeps
  // its own flag — its vector is its own.
  merged.text_vector_dirty = movedTextVector ? (oldRow.text_vector_dirty ?? 0) : (newRow.text_vector_dirty ?? 0);

  return merged;
}

export interface AdoptionResult {
  adopted: number;
  map: Map<string, string>;
}

export function adoptRotatedIds(liveIds: ReadonlySet<string>): AdoptionResult {
  const d = requireDb();
  const all = (d.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map((r) => r.id);
  const pairs: Array<[string, string]> = [];
  const claimed = new Set<string>();
  for (const old of all) {
    if (liveIds.has(old)) continue;
    const neu = canonicalId(old);
    // Dedupe by target (first wins): a years-old legacy row and its live
    // re-encode can map to the same id; the loser stays an orphan and prunes.
    if (neu === old || !liveIds.has(neu) || claimed.has(neu)) continue;
    claimed.add(neu);
    pairs.push([old, neu]);
  }
  if (pairs.length === 0) return { adopted: 0, map: new Map() };

  const plan = columnPlan();
  const cols = carriedColumns(plan);
  if (plan.unclassified.length) {
    // Not fatal — the default is to carry, which is the safe answer. Say so
    // loudly anyway: it means a migration landed without anyone deciding
    // whether the walk owns the column.
    console.warn(
      `[id-adoption] ${plan.unclassified.length} unclassified tracks column(s) carried by default: ` +
        `${plan.unclassified.join(', ')} — classify them in library-db/id-adoption.ts`,
    );
  }

  const getRow = d.prepare('SELECT * FROM tracks WHERE id = ?');
  const carry = d.prepare(
    `UPDATE tracks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
  );
  const getVec = d.prepare('SELECT embedding FROM track_vectors WHERE id = ?');
  const putVec = d.prepare('INSERT INTO track_vectors (id, embedding) VALUES (?, ?)');
  const delVec = d.prepare('DELETE FROM track_vectors WHERE id = ?');
  const getAudioVec = d.prepare('SELECT embedding FROM track_audio_vectors WHERE id = ?');
  const putAudioVec = d.prepare('INSERT INTO track_audio_vectors (id, embedding) VALUES (?, ?)');
  const delAudioVec = d.prepare('DELETE FROM track_audio_vectors WHERE id = ?');
  const movePlays = d.prepare('UPDATE plays SET track_id = ? WHERE track_id = ?');
  const delTrack = d.prepare('DELETE FROM tracks WHERE id = ?');
  const journal = d.prepare('INSERT OR REPLACE INTO id_rotation_journal (old_id, new_id) VALUES (?, ?)');

  // Only pairs the transaction actually applied. Reporting the CANDIDATE list
  // would hand the controller a manifest entry for a row that never received
  // anything (and whose old row the prune is about to delete), and tell the
  // operator we re-linked a track we didn't.
  const applied: Array<[string, string]> = [];

  const run = d.transaction((work: Array<[string, string]>) => {
    applied.length = 0;
    for (const [old, neu] of work) {
      const oldRow = getRow.get(old) as Row | undefined;
      const newRow = getRow.get(neu) as Row | undefined;
      // The walk upserted every live id before we run, so a missing new row
      // means something re-shaped the table mid-sync — leave the pair to the
      // prune rather than resurrect the old id.
      if (!oldRow || !newRow) continue;

      // sqlite-vec vec0 tables support neither INSERT OR REPLACE nor a pk
      // UPDATE — move the raw embedding buffer with delete + insert, the same
      // pattern upsertTrackVector uses. Done BEFORE the carry because
      // text_vector_dirty follows whichever text vector the new row ends up
      // holding.
      let movedTextVector = false;
      for (const [get, put, del, isText] of [
        [getVec, putVec, delVec, true] as const,
        [getAudioVec, putAudioVec, delAudioVec, false] as const,
      ]) {
        const oldVec = get.get(old) as { embedding: Buffer } | undefined;
        if (oldVec && !get.get(neu)) {
          put.run(neu, oldVec.embedding);
          if (isText) movedTextVector = true;
        }
        del.run(old);
      }

      const merged = mergeRow(plan, oldRow, newRow, movedTextVector);
      carry.run(...cols.map((c) => merged[c] ?? null), neu);

      movePlays.run(neu, old);
      journal.run(old, neu);
      delTrack.run(old);
      applied.push([old, neu]);
    }
  });
  run(pairs);

  return { adopted: applied.length, map: new Map(applied) };
}
