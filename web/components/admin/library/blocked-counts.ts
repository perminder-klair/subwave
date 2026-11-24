// The Blocked tab's per-line figure: how many library tracks each never-play
// entry keeps off the air, from the counts line's own tally
// (coverage.overview.blocked.byEntry, music/library-overview.ts). Each track
// counts once, for the most specific entry that blocks it, so a track entry
// inside a blocked album counts on the track's line, not the album's.

export interface BlockedCount {
  /** What the line shows, e.g. "14 tracks". */
  label: string;
  /** The hover text. */
  title: string;
  /** Blocks nothing in the library right now (dimmed). */
  none: boolean;
}

/**
 * Null while the figure is unknown: no overview yet, or an entry added after
 * the overview was counted (it recounts in the background, and the next
 * coverage read carries it).
 */
export function blockedCount(
  byEntry: Record<string, number> | undefined | null,
  entry: { type: string; id: string; addedAt?: string | null },
  computedAt: string | null | undefined,
): BlockedCount | null {
  if (!byEntry) return null;
  const n = byEntry[`${entry.type}:${entry.id}`] ?? 0;
  if (n === 0 && entry.addedAt && computedAt && entry.addedAt > computedAt) return null;
  const tracks = `${n.toLocaleString('en-GB')} track${n === 1 ? '' : 's'}`;
  return {
    label: tracks,
    title: n === 0
      ? 'blocks no track in the library right now (not in the library, or every one is already blocked by a more specific entry)'
      : `keeps ${tracks} off the air (a track that a more specific entry also blocks counts there)`,
    none: n === 0,
  };
}
