// The operator's lyric timing correction, one per track. A lyric file that is
// 2.9s out is 2.9s out for every listener, so the fix is station-wide and only
// the admin route writes it. Zero is "no correction" and deletes the row, so
// the table holds only tracks someone actually fixed.
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
