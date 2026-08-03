import { requireDb } from './handle.js';

export const LYRIC_OFFSET_MIN_MS = -30_000;
export const LYRIC_OFFSET_MAX_MS = 30_000;

export function clampLyricOffsetMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(LYRIC_OFFSET_MAX_MS, Math.max(LYRIC_OFFSET_MIN_MS, Math.round(value)));
}

export function getLyricOffset(clientId: string, trackId: string): number {
  if (!clientId || !trackId) return 0;
  const row = requireDb()
    .prepare('SELECT offset_ms FROM lyric_offsets WHERE client_id = ? AND track_id = ?')
    .get(clientId, trackId) as { offset_ms: number } | undefined;
  return row ? clampLyricOffsetMs(row.offset_ms) : 0;
}

export function setLyricOffset(clientId: string, trackId: string, offsetMs: number): number {
  const clamped = clampLyricOffsetMs(offsetMs);
  requireDb()
    .prepare(
      `INSERT INTO lyric_offsets (client_id, track_id, offset_ms, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id, track_id) DO UPDATE SET
         offset_ms = excluded.offset_ms,
         updated_at = excluded.updated_at`,
    )
    .run(clientId, trackId, clamped, new Date().toISOString());
  return clamped;
}

export function clearLyricOffset(clientId: string, trackId: string): void {
  if (!clientId || !trackId) return;
  requireDb()
    .prepare('DELETE FROM lyric_offsets WHERE client_id = ? AND track_id = ?')
    .run(clientId, trackId);
}
