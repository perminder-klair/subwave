// Stem provenance (#2238): which recording a cached stem window was cut from.
//
// A track's stem dir is keyed by its id, and an id outlives a change of audio:
// a file replaced in place whose dir forgetStems could not drop (the share was
// offline, a delete was refused), a dir the orphan purge hands back. The two
// windows are written at different times (a head-only pass, a tail-only
// pick-time pass, a tail the pass could not prove this time), so a dir could
// hold one recording's head beside another's tail and tail-meta.json, and the
// blend would loop the old recording's drums under the new one's bar grid.
//
// So each window carries a stamp, written by the analyzer after its stems
// (analyze_worker.py source_stamp / begin_window): head-meta.json and
// tail-meta.json, each with the source file's size in bytes and its decoded
// duration. Only a file the analyzer read whole states them; a capped download
// stamps both unknown. The worker also clears a mismatched window before it
// rewrites the other, so this read is the second guard, and the one that sees a
// dir older than the worker's own check.
//
// A mismatch is a plain cache miss, never an eviction: the next separation
// rewrites the dir, and the sweep owns deletes.
//
// Absent = unknown, which matches. A dir from before the stamps has no
// head-meta.json and a tail-meta.json without file_size, so an upgrade changes
// nothing: such a set keeps blending exactly as before.

export const HEAD_META = 'head-meta.json';
export const TAIL_META = 'tail-meta.json';

// Two readings of one file's decoded duration (a header probe, the placed
// tail's whole-file decode) agree well inside this. The same 2 s as the orphan
// purge's SAME_AUDIO_TOLERANCE_SEC, and analyze_worker.py's
// STAMP_DURATION_TOLERANCE_SEC: keep the three in step.
export const STAMP_DURATION_TOLERANCE_SEC = 2;

export interface StemStamp {
  fileSize: number | null;
  durationSec: number | null;
}

export const UNKNOWN_STAMP: StemStamp = { fileSize: null, durationSec: null };

const positive = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/** Pure: a parsed meta file's stamp, or null when it is not an object. */
export function parseStemStamp(raw: unknown): StemStamp | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const size = positive(r.file_size);
  return { fileSize: size != null ? Math.trunc(size) : null, durationSec: positive(r.duration_sec) };
}

/**
 * Pure: do two stamps name the same recording? Sizes decide when both are
 * known (byte-exact). Otherwise durations, within the tolerance. Otherwise
 * nothing is known, and they match. Mirrors analyze_worker.py same_recording.
 */
export function sameRecording(a: StemStamp, b: StemStamp): boolean {
  if (a.fileSize != null && b.fileSize != null) return a.fileSize === b.fileSize;
  if (a.durationSec != null && b.durationSec != null) {
    return Math.abs(a.durationSec - b.durationSec) <= STAMP_DURATION_TOLERANCE_SEC;
  }
  return true;
}

/**
 * Pure: may a window's stems be used? `own` is the window's stamp (absent:
 * UNKNOWN_STAMP; a head from before the stamps has none), `other` the other
 * window's when its meta is on disk, and `expectedFileSize` the size the
 * library row records for the file its analysis measured (tracks.file_size,
 * kept by the walk until a replacement is cleared). A window must agree with
 * both. Only the size is checked against the row: its duration is Subsonic's
 * tagged integer, not a decoded length.
 */
export function windowUsable(opts: {
  own: StemStamp;
  other: StemStamp | null;
  expectedFileSize?: number | null;
}): boolean {
  if (opts.other && !sameRecording(opts.own, opts.other)) return false;
  const expected = positive(opts.expectedFileSize);
  if (expected != null && opts.own.fileSize != null && opts.own.fileSize !== Math.trunc(expected)) return false;
  return true;
}
