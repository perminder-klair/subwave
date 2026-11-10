// Per-track lyrics state in library.db.
//
// lyric_offsets: the operator's lyric timing correction, one per track. A lyric
// file that is 2.9s out is 2.9s out for every listener, so the fix is
// station-wide and only the admin route writes it. Zero is "no correction" and
// deletes the row, so the table holds only tracks someone actually fixed.
//
// lyrics_external: what LRCLIB answered for a track, hit or miss, so the
// station asks about each track once rather than on every play.
import { requireDb } from './handle.js';

export function getLyricOffset(trackId: string): number {
  if (!trackId) return 0;
  const row = requireDb()
    .prepare('SELECT offset_ms FROM lyric_offsets WHERE track_id = ?')
    .get(trackId) as { offset_ms: number } | undefined;
  return row && Number.isFinite(row.offset_ms) ? row.offset_ms : 0;
}

// The caller validates the value (schemas/lyrics.ts lyricOffsetMsSchema).
export function setLyricOffset(trackId: string, offsetMs: number): void {
  const d = requireDb();
  if (offsetMs === 0) {
    d.prepare('DELETE FROM lyric_offsets WHERE track_id = ?').run(trackId);
    return;
  }
  d.prepare(
    `INSERT INTO lyric_offsets (track_id, offset_ms, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET
       offset_ms = excluded.offset_ms,
       updated_at = excluded.updated_at`,
  ).run(trackId, offsetMs, new Date().toISOString());
}

// What an external lyrics source answered for one track (music/lyrics-sources.ts).
// Both bodies null and `instrumental` false is a stored miss.
export interface ExternalLyrics {
  source: string;
  syncedLrc: string | null;
  plainText: string | null;
  instrumental: boolean;
  externalId: string | null;
  checkedAt: string;
}

export function getExternalLyrics(trackId: string): ExternalLyrics | null {
  if (!trackId) return null;
  const row = requireDb()
    .prepare(`SELECT source, synced_lrc, plain_text, instrumental, external_id, checked_at
              FROM lyrics_external WHERE track_id = ?`)
    .get(trackId) as {
      source: string; synced_lrc: string | null; plain_text: string | null;
      instrumental: number; external_id: string | null; checked_at: string;
    } | undefined;
  if (!row) return null;
  return {
    source: row.source,
    syncedLrc: row.synced_lrc,
    plainText: row.plain_text,
    instrumental: row.instrumental === 1,
    externalId: row.external_id,
    checkedAt: row.checked_at,
  };
}

export function setExternalLyrics(trackId: string, answer: Omit<ExternalLyrics, 'checkedAt'>, checkedAt = new Date()): void {
  requireDb().prepare(
    `INSERT INTO lyrics_external (track_id, source, synced_lrc, plain_text, instrumental, external_id, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET
       source = excluded.source,
       synced_lrc = excluded.synced_lrc,
       plain_text = excluded.plain_text,
       instrumental = excluded.instrumental,
       external_id = excluded.external_id,
       checked_at = excluded.checked_at`,
  ).run(
    trackId,
    answer.source,
    answer.syncedLrc,
    answer.plainText,
    answer.instrumental ? 1 : 0,
    answer.externalId,
    checkedAt.toISOString(),
  );
}
