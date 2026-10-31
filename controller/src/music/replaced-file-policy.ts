// When a library file counts as replaced: the walk keeps a track's id when its
// file is replaced at the same path (Navidrome derives the id from the path),
// so one of these signals is the only way the new audio ever gets measured.
// Pure: scripts/replaced-file.test.ts. Callers: library-db.upsertTrackMeta (the
// size), music/file-changes.ts (Navidrome's own change time) and the walk
// (tag-library/flags.ts), which clears the candidates behind decideReplacedClear.

import { pruneHoldThreshold } from './prune-policy.js';

// Any Subsonic server: the walked size differs from a known stored one. A
// stored NULL (a row walked before file facts existed) is not a change. Misses
// a repaired file that kept its exact size, which is what the change time is for.
export function fileReplaced(storedSize: number | null | undefined, walkedSize: number | null | undefined): boolean {
  return storedSize != null && storedSize > 0 && walkedSize != null && walkedSize > 0 && storedSize !== walkedSize;
}

// Navidrome: the server re-imported the file (its native `updatedAt`) after
// SUB/WAVE last measured the track (the newest analysis facet row). A track
// never measured has nothing stale to clear. A re-import also follows a
// tag-only edit, so such a track is re-analysed too: the accepted cost.
// `updatedAt` is the FILE's mtime (Navidrome's ModTime), not a server clock: a
// device with a wrong clock or a timezone-shifted SMB/FAT mount can date a file
// in the future, where it would postdate every measurement for ever and be
// re-analysed on every walk. A date past now + the margin is no change.
export function changedAfterMeasure(
  updatedAt: string | null | undefined,
  lastMeasuredAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!updatedAt || !lastMeasuredAt) return false;
  const changed = Date.parse(updatedAt);
  const measured = Date.parse(lastMeasuredAt);
  if (!Number.isFinite(changed) || !Number.isFinite(measured)) return false;
  if (futureDated(changed, now)) return false;
  return changed > measured;
}

// How far back each walk asks Navidrome for changes: from the newest change
// time the previous walk saw, less a margin for clock skew and a scan still
// writing while the previous walk read. No mark (the first walk): everything.
// A mark in the future (saved before the cap below, or by a skewed clock) is
// read as now: above every real change, it would blind the signal.
export const CHANGE_MARK_MARGIN_MS = 6 * 3_600_000;
export function changesFloor(mark: string | null | undefined, now: number = Date.now()): number | null {
  const t = mark ? Date.parse(mark) : NaN;
  return Number.isFinite(t) ? Math.min(t, now) - CHANGE_MARK_MARGIN_MS : null;
}

/** A file date past now + the margin: a wrong clock, never a real change. */
export function futureDated(changedMs: number, now: number = Date.now()): boolean {
  return changedMs > now + CHANGE_MARK_MARGIN_MS;
}

/** The mark a walk may save: the newest change it read, never later than now. */
export function capMark(newest: string | null | undefined, now: number = Date.now()): string | null {
  const t = newest ? Date.parse(newest) : NaN;
  if (!Number.isFinite(t)) return null;
  return t > now ? new Date(now).toISOString() : newest!;
}

// How many replaced tracks one walk may clear on its own. Clearing throws away
// the analyzer's work for each (days of it at library scale) and drops its
// stems, and some real events trip both signals across the whole library: a
// ReplayGain, Picard or beets "save all" (size and mtime on every file), a
// NAS migration or restore that does not keep mtimes, then a full scan. Held
// like a mass prune (music/prune-policy.ts, the same threshold): above it the
// walk clears nothing, says so, and asks for --confirm-replaced. The
// candidates are found again by the next walk (the size is not stored and the
// change-time mark does not move while held).
export type ReplacedDecision =
  | { clear: true }
  | { clear: false; message: string };

export function decideReplacedClear(opts: { candidates: number; knownTracks: number; confirmed: boolean }): ReplacedDecision {
  const limit = pruneHoldThreshold(opts.knownTracks);
  if (opts.candidates <= limit || opts.confirmed) return { clear: true };
  return {
    clear: false,
    message: `${opts.candidates.toLocaleString('en-GB')} tracks look replaced at the same path since they were measured `
      + `(more than ${limit.toLocaleString('en-GB')}): their audio analysis was NOT cleared. A tag editor's `
      + '"save all" or a restore that reset file dates does this. If the files really were replaced, '
      + 'run the tagger with --confirm-replaced to re-analyse them.',
  };
}
