// Stem cache (feature: stem-blend transitions) — per-track Demucs stem
// windows persisted by the analyzer worker (head 40s + tail 20s, 4 FLACs
// each) under `<stateDir>/stems/<trackId>/` (or under the STEMS_DIR bind mount
// when the operator relocated it — see resolveStemsRoot), so a render is a
// fast mix of cached stems instead of a fresh separation inside the drain
// deadline. The controller owns the LIFECYCLE (this module: paths, presence
// checks, byte-budget sweep — evicting by music/stem-priority.ts, the same
// ranking the backfill scans by); the analyzer owns the WRITES
// (analyze_worker.py write_stems — the same shared volume).

import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as db from './library-db.js';
import * as likes from '../broadcast/likes.js';
import { stemEvictionOrder, UNKNOWN_TRACK_PRIORITY } from './stem-priority.js';
import type { StemScanOpts } from './library-db.js';

export const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'] as const;
export type StemWindow = 'head' | 'tail';

// Pure path seam (scripts/stem-cache-root.test.ts). `relocated` (STEMS_DIR)
// addresses the INSTALL, not the station, so a multi-station install keeps its
// per-station segment under it — the cache is keyed by track id alone and a
// shared root would let station B render from station A's audio. No relocation
// gives `<stateDir>/stems`, so removing the var is a clean undo.
export function resolveStemsRoot(
  opts: { stateRoot: string; stateDir: string; relocated?: string },
): string {
  const relocated = opts.relocated?.trim();
  if (!relocated) return path.join(opts.stateDir, 'stems');
  // '' on a single-station install, 'stations/<id>' on a multi-station one. A
  // stateDir outside the root has no meaningful segment: fall back to the
  // relocated root rather than climbing out of it with '..'.
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
  // Guard the join so a hostile id can't escape the cache root: basename()
  // strips separators but returns "." / ".." verbatim, and path.join(root, "..")
  // resolves to the parent. Neutralise empty/dot-only names first.
  let safe = path.basename(String(trackId));
  if (safe === '' || /^\.+$/.test(safe)) safe = '_';
  return path.join(stemsRoot(), safe);
}

export function stemPath(trackId: string, window: StemWindow, stem: string): string {
  return path.join(dirFor(trackId), `${window}-${stem}.flac`);
}

// Whether a track has a complete stem set for the window; the render is
// cache-hit-only, so "all four present" is the eligibility fact. The tail window
// also needs its alignment sidecar (tail-meta.json: decoded duration + the exact
// tail offset the stems were cut at), without which the bar grid misaligns.
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

// Cold-start guess at one track's cached stem set, and the ceiling the admin UI
// quotes. Only used to SIZE a backfill, never to account for real usage (that
// walks the dirs). Real caches run well under it, so once enough dirs exist the
// measured average takes over (estimateTrackBytes).
export const APPROX_TRACK_BYTES = 25 * 1024 ** 2;

// How many dirs the cache needs before its own average outranks the guess —
// a handful of outliers must not swing the backfill sizing.
export const MEASURED_MIN_DIRS = 50;

// Floor for the measured average: failed/near-empty dirs would otherwise report
// a tiny per-track cost and oversize the backfill.
const MIN_TRACK_BYTES = 8 * 1024 ** 2;

// Pure sizing seam (pinned by scripts/stem-cache-sweep.test.ts): what one
// cached track costs, given what's actually on disk.
export function estimateTrackBytes(totalBytes: number, dirCount: number): number {
  if (dirCount < MEASURED_MIN_DIRS) return APPROX_TRACK_BYTES;
  return Math.max(MIN_TRACK_BYTES, Math.round(totalBytes / dirCount));
}

// Pure per-track gate for the analysis pass (#1257): stems ride along with every
// analysis when the cache is on, but must not grow it past the budget. An
// existing dir is a rewrite (no net-new bytes) and spends no slot.
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

// One walk of the cache root -> per-dir bytes + newest mtime, shared by the
// sweep and the usage report. ENOENT-tolerant: the analyzer may be writing.
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

// One-scan usage summary. Callers needing more than one figure must use this
// rather than the singles below, or they pay (and can race) a walk per figure.
export async function usage(): Promise<{ bytes: number; dirs: number; estTrackBytes: number }> {
  const scanned = await scanDirs();
  const bytes = scanned.reduce((n, d) => n + d.bytes, 0);
  return { bytes, dirs: scanned.length, estTrackBytes: estimateTrackBytes(bytes, scanned.length) };
}

export async function usageBytes(): Promise<number> {
  return (await usage()).bytes;
}

// Hittable stem dirs on disk, the doctor's coverage number. Distinct from
// library-db's stemsCachedCount(), which counts stems_at ATTEMPT stamps and so
// overstates once the sweep has evicted or a separation failed.
export async function cachedTrackCount(): Promise<number> {
  return (await usage()).dirs;
}

// Track ids with a stem dir on disk: one readdir, no per-dir walk. The analysis
// pass snapshots this to tell a rewrite from net-new growth (stemWriteDecision).
export async function cachedTrackIdSet(): Promise<Set<string>> {
  try {
    return new Set(await readdir(stemsRoot()));
  } catch {
    return new Set(); // no cache dir yet
  }
}

// Approximately how many more tracks the budget holds. The stem backfill caps
// its scope at this so it never separates tracks the sweep evicts minutes later
// (#1257); 0 = full, and the backfill stands down. `budget` defaults to the
// operator's setting; an explicit value mirrors sweep(budget).
export async function headroomTracks(budget = budgetBytes()): Promise<number> {
  const u = await usage();
  const free = budget - u.bytes;
  return free <= 0 ? 0 : Math.floor(free / u.estTrackBytes);
}

// The like signals the ranking reads, resolved once per caller.
//
// Read SYNCHRONOUSLY off whatever broadcast/likes.ts has already loaded, and
// deliberately without an `await likes.load()`: in the controller the store is
// loaded at boot (server.ts), and in the standalone tagger CLI it never is —
// where a load() would mint and persist a fresh dedup secret from a second
// process. An empty answer just drops the curation term from the score, which
// is the fail-open direction. `music/picker.ts` reads likes the same way.
export function likeSignals(): StemScanOpts {
  try {
    const operatorLikedIds: string[] = [];
    const listenerLikedIds: string[] = [];
    for (const s of likes.likedSongs()) {
      (s.operator ? operatorLikedIds : listenerLikedIds).push(s.songId);
    }
    return { operatorLikedIds, listenerLikedIds };
  } catch {
    return {};
  }
}

// Priority per cached dir, for the eviction order. Fails OPEN in one step: any
// throw (the library DB is not open in this process, the query fails) hands
// back a null priority for EVERY dir, and stemEvictionOrder then degrades to
// the plain mtime LRU this sweep used before #1622. A dir whose track is not
// in the catalogue at all — pruned from Navidrome — resolves to
// UNKNOWN_TRACK_PRIORITY and goes first, which is right: nothing can ever
// blend it.
function withPriorities(
  dirs: Array<{ dir: string; bytes: number; mtimeMs: number }>,
): Array<{ dir: string; bytes: number; mtimeMs: number; priority: number | null }> {
  let index: Map<string, number> | null = null;
  try {
    index = db.stemPriorityIndex(dirs.map(d => path.basename(d.dir)), likeSignals());
  } catch {
    index = null;
  }
  return dirs.map(d => ({
    ...d,
    priority: index ? index.get(path.basename(d.dir)) ?? UNKNOWN_TRACK_PRIORITY : null,
  }));
}

// Byte-budget sweep: track-dirs are evicted lowest-PRIORITY first (the same
// music/stem-priority.ts ranking the backfill scans by, so the cache keeps the
// tracks a rendered seam can actually use), oldest-mtime first inside every
// tie, until the cache fits the operator's budget (settings.audio.stemCacheGb).
// No existing LRU utility in the repo — byte accounting follows
// archives.pruneOlderThan, the sweep shape follows piper.cleanupOldVoices.
//
// Priority-first is not a refinement of the old plain mtime LRU, it is the
// correction the scan order forces. The backfill now writes the BEST tracks
// first, so they carry the OLDEST mtimes; keeping oldest-out would delete
// exactly what the ranking earned, and `stems_at` stamps the attempt, so those
// tracks would never be separated again. mtime survives as the tiebreak, which
// keeps "a re-analysis refreshes a dir's slot" true inside each tie — and is
// the whole sort when priorities cannot be resolved.
//
// Failures ride the RESULT rather than vanishing (#1257). A per-dir rm error is
// swallowed (retry next sweep), but `failedDirs` and `overBudgetBytes` are what
// let the call sites say out loud that nothing could be deleted — e.g. a stems
// mount the controller container cannot delete from.
export async function sweep(budget = budgetBytes()): Promise<{
  removed: number;
  freedBytes: number;
  failedDirs: number;
  overBudgetBytes: number;
}> {
  const dirs = await scanDirs();
  let total = dirs.reduce((n, d) => n + d.bytes, 0);
  if (total <= budget) return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0 };

  const ordered = stemEvictionOrder(withPriorities(dirs));
  let removed = 0;
  let freedBytes = 0;
  let failedDirs = 0;
  for (const d of ordered) {
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
