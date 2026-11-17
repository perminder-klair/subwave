// Display helpers for the Era tab's track list: where a file lives, in words
// short enough for a table cell. Pure, so the shapes are tested on their own.

/** "3:40"; null/unknown → "". */
export function formatTrackLength(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The last `parts` segments of a folder ("PLAYLISTS/Rock"), the full path
 *  being kept for the tooltip. */
export function shortFolder(folder: string | null | undefined, parts = 2): string {
  if (!folder) return '';
  const segs = folder.split('/').filter(Boolean);
  return segs.length <= parts ? segs.join('/') : `…/${segs.slice(-parts).join('/')}`;
}

/** The ids a year typed on one entry is saved to: the entry and every copy of
 *  the same recording, which the list folds under it. */
export function yearTargets(t: { id: string; copies?: ReadonlyArray<{ id: string }> }): string[] {
  return [t.id, ...(t.copies ?? []).map(c => c.id).filter(id => id !== t.id)];
}
