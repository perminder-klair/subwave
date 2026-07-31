// Adoption of rotated Navidrome ids (PR #5824's uniform_canonical_ids
// migration). When Navidrome rewrites its ids, the walk inserts every track
// under a NEW id and pruneMissingTracks would hard-delete every OLD row —
// losing tags, enrichment, acoustic analysis and both vector indexes for the
// whole library. This module runs between walk and prune: an orphan whose
// canonicalId() image is a DIFFERENT id that the walk just saw live gets its
// derived columns, vector rows and play attribution moved onto the new row,
// then the old row is deleted so the prune has nothing left to do.
//
// Self-validating by construction: the mapping only fires when the canonical
// image exists in the live-id set, so on a server that never migrated (or if
// upstream changes the transform before release) nothing matches and the sync
// behaves byte-for-byte like today. A genuinely deleted track fails the
// `image !== old` test (hash-family ids are fixed points) and still prunes.

import { requireDb } from './handle.js';
import { canonicalId } from '../id-canonical.js';

// Carried column groups. Walk-owned metadata (title/artist/album/year/genres/
// is_compilation/duration_sec) is deliberately absent — the new row's copy is
// fresher — and `genre` is GENERATED ALWAYS, so writing it would throw.
// Each group is anchored on one column so a new row that already re-derived a
// group (re-run, race with a tagger phase) keeps its own values; the
// stand-alone columns mirror their write-path COALESCE semantics
// (upsertTrackAnalysis).
const GROUPS: Array<{ anchor: string; cols: string[] }> = [
  { anchor: 'enriched_at', cols: ['lastfm_tags', 'lyric_excerpt', 'enriched_at'] },
  { anchor: 'moods', cols: ['moods', 'energy', 'source', 'confidence', 'tagger_version', 'prompt_hash', 'model', 'tagged_at'] },
  {
    anchor: 'analysis_version',
    cols: ['bpm', 'musical_key', 'intro_ms', 'analysis_confidence', 'analysis_version', 'loudness_lufs',
      'peak_db', 'structure_json', 'pace_json', 'beats_json', 'bars_json', 'key_ranges_json'],
  },
  { anchor: 'audio_moods', cols: ['audio_moods', 'audio_mood_scores_json'] },
  { anchor: 'map_x', cols: ['map_x', 'map_y'] },
];
const COALESCE_COLS = ['vocal_ranges_json', 'outro_json', 'stems_at', 'original_year_checked_at'];

const ALL_COLS = [
  ...GROUPS.flatMap((g) => g.cols),
  ...COALESCE_COLS,
  'original_year',
  'original_year_source',
];

type Row = Record<string, unknown>;

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

  const getRow = d.prepare('SELECT * FROM tracks WHERE id = ?');
  const carry = d.prepare(
    `UPDATE tracks SET ${ALL_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
  );
  const getVec = d.prepare('SELECT embedding FROM track_vectors WHERE id = ?');
  const putVec = d.prepare('INSERT INTO track_vectors (id, embedding) VALUES (?, ?)');
  const delVec = d.prepare('DELETE FROM track_vectors WHERE id = ?');
  const getAudioVec = d.prepare('SELECT embedding FROM track_audio_vectors WHERE id = ?');
  const putAudioVec = d.prepare('INSERT INTO track_audio_vectors (id, embedding) VALUES (?, ?)');
  const delAudioVec = d.prepare('DELETE FROM track_audio_vectors WHERE id = ?');
  const movePlays = d.prepare('UPDATE plays SET track_id = ? WHERE track_id = ?');
  const delTrack = d.prepare('DELETE FROM tracks WHERE id = ?');

  const run = d.transaction((work: Array<[string, string]>) => {
    for (const [old, neu] of work) {
      const oldRow = getRow.get(old) as Row | undefined;
      const newRow = getRow.get(neu) as Row | undefined;
      // The walk upserted every live id before we run, so a missing new row
      // means something re-shaped the table mid-sync — leave the pair to the
      // prune rather than resurrect the old id.
      if (!oldRow || !newRow) continue;

      const merged: Row = {};
      for (const g of GROUPS) {
        const take = newRow[g.anchor] == null;
        for (const c of g.cols) merged[c] = take ? oldRow[c] : newRow[c];
      }
      for (const c of COALESCE_COLS) merged[c] = newRow[c] ?? oldRow[c];
      // Mirror upsertTrackMeta's precedence: a MusicBrainz resolution on the
      // old row outranks the walk-time album-tag year the new row just got.
      const mbWins = oldRow.original_year_source === 'musicbrainz' || newRow.original_year == null;
      merged.original_year = mbWins ? oldRow.original_year : newRow.original_year;
      merged.original_year_source = mbWins ? oldRow.original_year_source : newRow.original_year_source;

      carry.run(...ALL_COLS.map((c) => merged[c] ?? null), neu);

      // sqlite-vec vec0 tables support neither INSERT OR REPLACE nor a pk
      // UPDATE — move the raw embedding buffer with delete + insert, the same
      // pattern upsertTrackVector uses.
      for (const [get, put, del] of [
        [getVec, putVec, delVec] as const,
        [getAudioVec, putAudioVec, delAudioVec] as const,
      ]) {
        const oldVec = get.get(old) as { embedding: Buffer } | undefined;
        if (oldVec && !get.get(neu)) put.run(neu, oldVec.embedding);
        del.run(old);
      }

      movePlays.run(neu, old);
      delTrack.run(old);
    }
  });
  run(pairs);

  return { adopted: pairs.length, map: new Map(pairs) };
}
