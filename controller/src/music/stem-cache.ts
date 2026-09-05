// Stem cache (feature: stem-blend transitions) — per-track Demucs stem
// windows persisted by the analyzer worker (head 40s + tail 20s, 4 FLACs
// each) under `<stateDir>/stems/<trackId>/` (or under the STEMS_DIR bind mount
// when the operator relocated it — see resolveStemsRoot), so a render is a
// fast mix of cached stems instead of a fresh separation inside the drain
// deadline. The controller owns the LIFECYCLE (this module: paths, presence
// checks, byte-budget LRU sweep); the analyzer owns the WRITES
// (analyze_worker.py write_stems — the same shared volume).

import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';

export const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'] as const;
export type StemWindow = 'head' | 'tail';

// Pure path seam (pinned by scripts/stem-cache-root.test.ts): where the cache
// lives, given the state layout and an optional relocated root.
//
// `relocated` is the container path of the STEMS_DIR bind mount. It addresses
// the INSTALL, not the station, because compose cannot know which station is
// active — the pointer is read at boot by the controller and the broadcast
// entrypoint, long after the mount is fixed. So a multi-station install keeps
// its per-station segment UNDER the relocated root: Navidrome credentials are
// per-station (setup/config.ts), two stations can therefore index different
// libraries, and this cache is keyed by track id alone — sharing one root
// between them would let station B render a transition from station A's audio.
//
// No relocation → `<stateDir>/stems`, byte-identical to a pre-STEMS_DIR
// install, which is what makes removing STEMS_DIR from .env a clean undo.
export function resolveStemsRoot(
  opts: { stateRoot: string; stateDir: string; relocated?: string },
): string {
  const relocated = opts.relocated?.trim();
  if (!relocated) return path.join(opts.stateDir, 'stems');
  // '' on a single-station install, 'stations/<id>' on a multi-station one.
  // A stateDir outside the root (native dev with STATE_DIR pointing elsewhere)
  // has no meaningful segment — fall back to the relocated root itself rather
  // than climbing out of it with '..'.
  const segment = path.relative(opts.stateRoot, opts.stateDir);
  if (!segment || segment.startsWith('..') || path.isAbsolute(segment)) return relocated;
  return path.join(relocated, segment);
}

export function stemsRoot(): string {
  return resolveStemsRoot({
    stateRoot: config.stateRoot,
    stateDir: config.stateDir,
    relocated: config.stemsDir,
  });
}

export function dirFor(trackId: string): string {
  // Track ids are Navidrome UUID-ish tokens; guard the join anyway so a
  // hostile id can never escape the cache root. basename() strips path
  // separators but returns "." / ".." verbatim, and path.join(root, "..")
  // would resolve to the PARENT of the cache root — so neutralise any
  // empty or dot-only name to a safe in-root token first.
  let safe = path.basename(String(trackId));
  if (safe === '' || /^\.+$/.test(safe)) safe = '_';
  return path.join(stemsRoot(), safe);
}

export function stemPath(trackId: string, window: StemWindow, stem: string): string {
  return path.join(dirFor(trackId), `${window}-${stem}.flac`);
}

// Whether a track has a complete stem set for the given window. The render
// op is cache-hit-only, so "all four present" is the eligibility fact. The
// tail window also needs its alignment sidecar (tail-meta.json — the decoded
// duration + exact tail offset the stems were cut at): the render slices the
// bar grid against that offset, and stems cached before the sidecar existed
// would misalign by the tagged-vs-decoded duration gap, so they count as a
// miss until a re-analysis refreshes them.
export async function hasWindow(trackId: string, window: StemWindow): Promise<boolean> {
  try {
    const files = STEM_NAMES.map(s => stemPath(trackId, window, s));
    if (window === 'tail') files.push(path.join(dirFor(trackId), 'tail-meta.json'));
    const checks = await Promise.all(
      files.map(f => stat(f).then(st => st.size > 0, () => false)),
    );
    return checks.every(Boolean);
  } catch {
    return false;
  }
}

// The operator's byte budget (settings.audio.stemCacheGb), floored at 1 GB so
// a corrupt/zero setting can't collapse the cache to nothing.
export function budgetBytes(): number {
  return Math.max(1, Number(settings.get()?.audio?.stemCacheGb) || 15) * 1024 ** 3;
}

// Rough on-disk cost of one track's cached stem set (head 40s + tail 20s, four
// FLACs each) — the ceiling the admin UI quotes. Only used to SIZE a backfill,
// never to account for real usage (that walks the dirs), so an approximation
// is fine: being a few MB out changes how many tracks a night targets, nothing
// that can corrupt the cache. Real-world caches average well under this
// (~13 MB/track over 53k tracks in the #1257 report — stem FLACs are mostly
// quiet channels and compress hard, and head-only sets are smaller still), so
// once the cache holds enough dirs to be representative the MEASURED average
// takes over (estimateTrackBytes below) and this stays the cold-start guess.
export const APPROX_TRACK_BYTES = 25 * 1024 ** 2;

// How many dirs the cache needs before its own average outranks the guess —
// a handful of outliers must not swing the backfill sizing.
export const MEASURED_MIN_DIRS = 50;

// Floor for the measured average: a cache polluted by failed/near-empty dirs
// would otherwise report a tiny per-track cost and size a backfill far past
// what the budget really holds.
const MIN_TRACK_BYTES = 8 * 1024 ** 2;

// Pure sizing seam (pinned by scripts/stem-cache-sweep.test.ts): what one
// cached track costs, given what's actually on disk.
export function estimateTrackBytes(totalBytes: number, dirCount: number): number {
  if (dirCount < MEASURED_MIN_DIRS) return APPROX_TRACK_BYTES;
  return Math.max(MIN_TRACK_BYTES, Math.round(totalBytes / dirCount));
}

// Pure per-track gate for the analysis pass (#1257): stems ride along with
// EVERY analysis when the cache is on (the separation is paid for anyway),
// but the ride-alongs must not grow the cache past the operator's budget —
// that's how a 500 GB budget ended up holding 674 GB. A track whose dir
// already exists is a REWRITE (no net-new bytes), so it never needs a slot;
// a net-new dir spends one.
export function stemWriteDecision(opts: {
  cacheOn: boolean;
  slotsLeft: number;
  hasExistingDir: boolean;
}): { want: boolean; consumesSlot: boolean } {
  if (!opts.cacheOn) return { want: false, consumesSlot: false };
  if (opts.hasExistingDir) return { want: true, consumesSlot: false };
  return opts.slotsLeft > 0
    ? { want: true, consumesSlot: true }
    : { want: false, consumesSlot: false };
}

// One walk of the cache root -> per-dir bytes + newest mtime. Shared by the
// sweep and the usage report so the two can never disagree about what's on
// disk. ENOENT-tolerant throughout: the analyzer may be writing a dir while we
// scan.
async function scanDirs(): Promise<Array<{ dir: string; bytes: number; mtimeMs: number }>> {
  let entries: string[];
  try {
    entries = await readdir(stemsRoot());
  } catch {
    return []; // no cache dir yet
  }
  const dirs: Array<{ dir: string; bytes: number; mtimeMs: number }> = [];
  for (const name of entries) {
    const dir = path.join(stemsRoot(), name);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
      let bytes = 0;
      let mtimeMs = 0;
      for (const f of await readdir(dir)) {
        try {
          const fst = await stat(path.join(dir, f));
          bytes += fst.size;
          if (fst.mtimeMs > mtimeMs) mtimeMs = fst.mtimeMs;
        } catch { /* file vanished mid-scan */ }
      }
      dirs.push({ dir, bytes, mtimeMs });
    } catch { /* dir vanished mid-scan */ }
  }
  return dirs;
}

// One-scan usage summary — bytes on disk, dirs on disk, and the per-track
// cost estimate those two imply. Callers that need more than one of these
// must use this rather than the singles below, or they pay (and can race)
// a 50k-dir walk per figure.
export async function usage(): Promise<{ bytes: number; dirs: number; estTrackBytes: number }> {
  const scanned = await scanDirs();
  const bytes = scanned.reduce((n, d) => n + d.bytes, 0);
  return { bytes, dirs: scanned.length, estTrackBytes: estimateTrackBytes(bytes, scanned.length) };
}

export async function usageBytes(): Promise<number> {
  return (await usage()).bytes;
}

// How many track dirs are on disk RIGHT NOW — the doctor's coverage number.
// Deliberately distinct from library-db's stemsCachedCount(): stems_at stamps
// ATTEMPTS (and must, for the backfill scope to converge), so once the sweep
// has evicted anything — or a separation failed — the stamp count overstates
// what a blend can actually hit. This counts hittable dirs instead.
export async function cachedTrackCount(): Promise<number> {
  return (await usage()).dirs;
}

// The track ids that have a stem dir on disk — one readdir, no per-dir walk.
// The analysis pass snapshots this to tell a rewrite (dir exists, costs no
// budget slot) from net-new growth; see stemWriteDecision.
export async function cachedTrackIdSet(): Promise<Set<string>> {
  try {
    return new Set(await readdir(stemsRoot()));
  } catch {
    return new Set(); // no cache dir yet
  }
}

// How many more tracks the budget can hold, approximately. The stem backfill
// caps its scope at this: separating thousands of tracks the sweep will evict
// minutes later is hours of Demucs time for nothing, which is what made the
// feature look broken on a library bigger than the budget ("it will only ever
// cache the last 600 songs"). 0 = cache full, so the backfill stands down and
// says so rather than churning. Sized off the cache's own measured average
// once it has one (estimateTrackBytes) — the fixed 25 MB guess ran ~2x
// pessimistic in the field (#1257).
// `budget` defaults to the operator's setting; an explicit value mirrors
// sweep(budget) so the two can be reasoned about (and tested) together.
export async function headroomTracks(budget = budgetBytes()): Promise<number> {
  const u = await usage();
  const free = budget - u.bytes;
  return free <= 0 ? 0 : Math.floor(free / u.estTrackBytes);
}

// Byte-budget LRU sweep: newest track-dirs (by max file mtime — a re-analysis
// refreshes a dir's slot) are kept, oldest evicted until the cache fits the
// operator's budget (settings.audio.stemCacheGb). No existing LRU utility in
// the repo — byte accounting follows archives.pruneOlderThan, the sweep shape
// follows piper.cleanupOldVoices.
//
// Failures must ride the RESULT, not vanish (#1257): a per-dir rm error is
// swallowed here by design (retry next sweep), but when EVERY delete fails —
// e.g. the stems mount isn't deletable by the controller container — the old
// shape returned {removed: 0}, which both call sites read as "nothing to do".
// A 500 GB budget sat at 674 GB for a week with zero operator signal.
// `failedDirs` counts dirs whose delete threw this sweep; `overBudgetBytes`
// is how far the cache still overhangs the budget after it — either being
// non-zero is the call sites' cue to say so out loud.
export async function sweep(budget = budgetBytes()): Promise<{
  removed: number;
  freedBytes: number;
  failedDirs: number;
  overBudgetBytes: number;
}> {
  const dirs = await scanDirs();
  let total = dirs.reduce((n, d) => n + d.bytes, 0);
  if (total <= budget) return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0 };

  dirs.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let removed = 0;
  let freedBytes = 0;
  let failedDirs = 0;
  for (const d of dirs) {
    if (total <= budget) break;
    try {
      await rm(d.dir, { recursive: true, force: true });
      total -= d.bytes;
      freedBytes += d.bytes;
      removed += 1;
    } catch { failedDirs += 1; /* best-effort — retry next sweep */ }
  }
  return { removed, freedBytes, failedDirs, overBudgetBytes: Math.max(0, total - budget) };
}
