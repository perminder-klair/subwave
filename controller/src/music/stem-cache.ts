// The analyzer writes cached head/tail stems on the shared volume. The controller manages
// paths and evicts by the same priority the backfill uses.

import { readdir, stat, rm, readFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as db from './library-db.js';
import * as likes from '../broadcast/likes.js';
import { stemEvictionOrder, UNKNOWN_TRACK_PRIORITY } from './stem-priority.js';
import { mapPool } from '../util/async-pool.js';
import type { StemScanOpts } from './library-db.js';
import { writeFileAtomic } from '../util/atomic-file.js';

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

// Stems share marker. A relocated cache usually lives on a network mount
// (STEMS_DIR), and an unmounted share looks exactly like an empty cache: the
// mount point is still there, with nothing in it. Read as "empty", that sends
// the backfill off to re-separate the whole budget onto the local disk, and
// stamps those tracks as attempted. So the cache carries a marker file at its
// root, and nothing writes, backfills or sweeps without it.
export const STEMS_MARKER = '.subwave-stems';

export type StemsRootAction = 'ok' | 'adopt' | 'create' | 'offline' | 'none';

// Pure decision seam (scripts/stems-root-marker.test.ts).
// - marker present: the cache is mounted.
// - no marker, but track dirs on disk: a cache from before the marker existed;
//   adopt it (write the marker).
// - no marker, no dirs, but the catalogue has stamped stems: the cache the
//   catalogue remembers is not here, which is what an unmounted share looks
//   like. Offline until the operator mounts it, or creates the marker by hand
//   to start an empty cache on purpose.
// - nothing anywhere: a new cache. Created only when the caller is about to
//   write stems (`prepare`); a sweep or a status read leaves the disk alone.
export function stemsRootDecision(opts: {
  markerPresent: boolean;
  stemDirs: number;
  stampedTracks: number;
  prepare: boolean;
}): StemsRootAction {
  if (opts.markerPresent) return 'ok';
  if (opts.stemDirs > 0) return 'adopt';
  if (opts.stampedTracks > 0) return 'offline';
  return opts.prepare ? 'create' : 'none';
}

export interface StemsRootStatus {
  // true = stems may be written, backfilled and swept.
  online: boolean;
  action: StemsRootAction;
  // Set when offline, or when an existing cache could not take the marker:
  // what the operator sees in the logs and the doctor.
  message?: string;
}

function stampedStemCount(): number {
  try {
    return db.isOpen() ? db.stemsCachedCount() : 0;
  } catch {
    return 0;
  }
}

async function writeMarker(root: string): Promise<string | undefined> {
  const resolvedRoot = path.resolve(root);
  const firstCreated = await mkdir(resolvedRoot, { recursive: true, mode: 0o777 });
  const warnings: string[] = [];
  // mkdir's mode is masked by umask. Share every new ancestor with the analyzer,
  // but leave existing mounts alone, including read-only legacy caches.
  if (firstCreated) {
    let dir = resolvedRoot;
    while (true) {
      try {
        await chmod(dir, 0o777);
      } catch (err) {
        const shared = await stat(dir).then(st => (st.mode & 0o003) === 0o003, () => false);
        if (!shared) {
          warnings.push(`Stem cache: could not share ${dir} with the analyzer (${err instanceof Error ? err.message : String(err)}); check its permissions on the host`);
        }
      }
      if (dir === firstCreated) break;
      dir = path.dirname(dir);
    }
  }
  await writeFile(
    path.join(root, STEMS_MARKER),
    JSON.stringify({ createdAt: new Date().toISOString(), note: 'SUB/WAVE stem cache root; stems are only written, backfilled and swept while this file is present' }) + '\n',
  );
  return warnings.length > 0 ? warnings.join('\n') : undefined;
}

// Checks (and when allowed, establishes) the marker. One stat when the marker
// is there; one readdir of the root only when it is missing.
// `readOnly` (the doctor and sweep) reports the decision without writing the marker.
export async function stemsRootStatus(opts: { prepare?: boolean; readOnly?: boolean } = {}): Promise<StemsRootStatus> {
  const root = stemsRoot();
  const markerPresent = await stat(path.join(root, STEMS_MARKER)).then(() => true, () => false);
  let stemDirs = 0;
  if (!markerPresent) {
    try {
      stemDirs = (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).length;
    } catch { /* no root yet */ }
  }
  const action = stemsRootDecision({
    markerPresent,
    stemDirs,
    stampedTracks: markerPresent || stemDirs > 0 ? 0 : stampedStemCount(),
    prepare: opts.prepare === true,
  });
  let message: string | undefined;
  if ((action === 'adopt' || action === 'create') && !opts.readOnly) {
    try {
      message = await writeMarker(root);
    } catch (err) {
      // Stem dirs on disk prove the share is mounted: a root that refuses the
      // marker stays online, so the sweep still reports deletes it cannot do
      // (#1257) instead of going quiet. The adoption is retried next time.
      if (action === 'adopt') {
        return {
          online: true,
          action,
          message: `Stem cache: could not write the ${STEMS_MARKER} marker in ${root} (${(err as Error)?.message || err}); the cache stays in use, but an unmounted share can't be told from an empty one until the marker exists`,
        };
      }
      // A new cache whose root can't be written: stem writes would fail the
      // same way.
      return {
        online: false,
        action: 'offline',
        message: `Stem cache: cannot write the ${STEMS_MARKER} marker in ${root} (${(err as Error)?.message || err}); stems are off until it can be written`,
      };
    }
  }
  if (action === 'offline') {
    return {
      online: false,
      action,
      message:
        `Stem cache: ${root} is empty and has no ${STEMS_MARKER} marker, but the library has stems recorded for some tracks. ` +
        'If the stems share is not mounted, mount it; stems are not written, backfilled or swept until the marker is back. ' +
        `To start an empty cache on purpose, create the file ${path.join(root, STEMS_MARKER)}.`,
    };
  }
  return { online: action !== 'none', action, ...(message ? { message } : {}) };
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
// existing dir spends no slot; its possible growth is measured after the pass.
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

// How many track dirs one walk measures at once. Each dir is a readdir plus a
// stat per file; one at a time, a walk is a long chain of round trips, which
// on a network share (STEMS_DIR on NFS/SMB) is all latency: 12 min 25 s for
// 63k dirs, measured. A bounded fan-out overlaps them. Local disks are barely
// affected either way, and the bound keeps the number of open handles small.
export const SCAN_CONCURRENCY = 16;

async function measureDir(dir: string): Promise<{ dir: string; bytes: number; mtimeMs: number } | null> {
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return null;
    const files = await readdir(dir);
    const stats = await Promise.all(
      files.map(f => stat(path.join(dir, f)).catch(() => null)), // file vanished mid-scan
    );
    let bytes = 0;
    let mtimeMs = 0;
    for (const fst of stats) {
      if (!fst) continue;
      bytes += fst.size;
      if (fst.mtimeMs > mtimeMs) mtimeMs = fst.mtimeMs;
    }
    return { dir, bytes, mtimeMs };
  } catch {
    return null; // dir vanished mid-scan
  }
}

// One walk of the cache root -> per-dir bytes + newest mtime, shared by the
// sweep and the usage report. ENOENT-tolerant: the analyzer may be writing.
async function scanDirs(): Promise<Array<{ dir: string; bytes: number; mtimeMs: number }>> {
  let entries: string[];
  const root = stemsRoot();
  try {
    entries = await readdir(root);
  } catch {
    return []; // no cache dir yet
  }
  const measured = await mapPool(entries, SCAN_CONCURRENCY, name => measureDir(path.join(root, name)));
  return measured.filter((d): d is { dir: string; bytes: number; mtimeMs: number } => d !== null);
}

// ---- usage snapshot -------------------------------------------------------
// A full walk stats every file of every track dir: hundreds of thousands of
// metadata reads on a large cache, which wakes a sleeping disk every hour and,
// on a network share, takes minutes. Nearly every hour nothing has changed, so
// the last walk's totals are kept in <stateDir>/stem-cache-usage.json and
// reused while they can be trusted:
// - the only writer of stem dirs is the analysis pass, which marks the
//   snapshot `pending` while it runs and adds the dirs it wrote when it ends;
// - evictions are made by sweep(), which rewrites the snapshot from its walk;
// - anything else (dirs deleted or copied in by hand, a pass that died before
//   settling) is caught by a full walk at least every SNAPSHOT_MAX_AGE_MS.
export const SNAPSHOT_MAX_AGE_MS = 24 * 3600_000;
// A pass that has been "running" longer than this is treated as dead.
const PENDING_MAX_AGE_MS = 48 * 3600_000;
let snapshotUntrusted = false;

export interface UsageSnapshot {
  version: 1;
  root: string;
  bytes: number;
  dirs: number;
  // Last FULL walk; the snapshot is stale once this is older than the max age.
  measuredAt: string;
  updatedAt: string;
  // An analysis pass that may be writing stem dirs right now.
  pending?: { pid: number; since: string };
}

export type SnapshotVerdict = 'use' | 'walk' | 'pass-running';

// Pure seam (scripts/stem-cache-snapshot.test.ts): may this snapshot stand in
// for a walk?
export function snapshotVerdict(opts: {
  snap: UsageSnapshot | null;
  root: string;
  nowMs: number;
  pendingAlive: boolean;
}): SnapshotVerdict {
  const { snap } = opts;
  if (!snap || snap.version !== 1 || snap.root !== opts.root) return 'walk';
  if (!Number.isFinite(snap.bytes) || !Number.isFinite(snap.dirs)) return 'walk';
  if (snap.pending) {
    const since = Date.parse(snap.pending.since);
    const fresh = Number.isFinite(since) && opts.nowMs - since < PENDING_MAX_AGE_MS;
    // A live pass settles the budget itself when it ends; a dead one may have
    // written dirs nobody counted.
    return opts.pendingAlive && fresh ? 'pass-running' : 'walk';
  }
  const measured = Date.parse(snap.measuredAt);
  if (!Number.isFinite(measured) || opts.nowMs - measured > SNAPSHOT_MAX_AGE_MS || measured > opts.nowMs + 60_000) return 'walk';
  return 'use';
}

function snapshotPath(): string {
  return path.join(config.stateDir, 'stem-cache-usage.json');
}

async function readSnapshot(): Promise<UsageSnapshot | null> {
  try {
    return JSON.parse(await readFile(snapshotPath(), 'utf8')) as UsageSnapshot;
  } catch {
    return null;
  }
}

async function writeSnapshot(snap: UsageSnapshot): Promise<boolean> {
  try {
    await writeFileAtomic(snapshotPath(), JSON.stringify(snap) + '\n');
    snapshotUntrusted = false;
    return true;
  } catch {
    // The old file may still exist. This process must not reuse its totals.
    snapshotUntrusted = true;
    return false;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

async function snapshotState(): Promise<{ snap: UsageSnapshot | null; verdict: SnapshotVerdict }> {
  const snap = await readSnapshot();
  const verdict = snapshotVerdict({
    snap,
    root: stemsRoot(),
    nowMs: Date.now(),
    pendingAlive: snap?.pending ? pidAlive(snap.pending.pid) : false,
  });
  return { snap, verdict: snapshotUntrusted && verdict === 'use' ? 'walk' : verdict };
}

function snapshotFromWalk(bytes: number, dirs: number): UsageSnapshot {
  const now = new Date().toISOString();
  return { version: 1, root: stemsRoot(), bytes, dirs, measuredAt: now, updatedAt: now };
}

async function walkUsage(): Promise<{ bytes: number; dirs: number }> {
  const before = await snapshotState();
  const scanned = await scanDirs();
  const bytes = scanned.reduce((n, d) => n + d.bytes, 0);
  const after = await snapshotState();
  // A live pass owns the additive baseline. A read must not count its writes
  // into that baseline, including when the pass starts during this walk.
  if (before.verdict !== 'pass-running' && after.verdict !== 'pass-running'
    && JSON.stringify(before.snap) === JSON.stringify(after.snap)) {
    await writeSnapshot(snapshotFromWalk(bytes, scanned.length));
  }
  return { bytes, dirs: scanned.length };
}

// One-scan usage summary. Callers needing more than one figure must use this
// rather than the singles below, or they pay (and can race) a walk per figure.
// Served from the snapshot when it can be trusted (see above); a running
// pass's snapshot is not, since dirs are being added under it.
export async function usage(): Promise<{ bytes: number; dirs: number; estTrackBytes: number }> {
  const { snap, verdict } = await snapshotState();
  const { bytes, dirs } = verdict === 'use' && snap ? snap : await walkUsage();
  return { bytes, dirs, estTrackBytes: estimateTrackBytes(bytes, dirs) };
}

// The analysis pass marks the snapshot while it may write stem dirs. Called
// after its headroom read, so that read could still use the snapshot.
export async function markPassPending(): Promise<boolean> {
  const { snap, verdict } = await snapshotState();
  if (verdict !== 'use' || !snap) {
    snapshotUntrusted = true;
    return false;
  }
  return writeSnapshot({ ...snap, pending: { pid: process.pid, since: new Date().toISOString() }, updatedAt: new Date().toISOString() });
}

// Bytes on disk under one track dir (one readdir + a stat per file).
async function dirBytes(dir: string): Promise<number | null> {
  try {
    let bytes = 0;
    for (const f of await readdir(dir)) {
      try { bytes += (await stat(path.join(dir, f))).size; } catch { /* vanished */ }
    }
    return bytes;
  } catch {
    return null; // never written (failed separation, or offline)
  }
}

// End of an analysis pass: add the NET-NEW dirs it allocated to the snapshot
// (measuring just those), clear the pending mark, and say whether the cache is
// still inside the budget. Existing dirs may gain a missing tail, so a pass
// that rewrote one invalidates the snapshot and takes a full walk instead.
// An untrusted settlement also invalidates old totals, even if its file remains.
export async function settlePassWrites(
  newTrackIds: Iterable<string>,
  budget = budgetBytes(),
  { rewroteExisting = false }: { rewroteExisting?: boolean } = {},
): Promise<{ bytes: number; dirs: number; withinBudget: boolean } | null> {
  const snap = await readSnapshot();
  const mine = snap?.pending?.pid === process.pid;
  const base = snapshotVerdict({ snap, root: stemsRoot(), nowMs: Date.now(), pendingAlive: true });
  if (snapshotUntrusted || rewroteExisting || !snap || !mine || base !== 'pass-running') {
    snapshotUntrusted = true;
    return null;
  }
  let bytes = snap.bytes;
  let dirs = snap.dirs;
  for (const id of newTrackIds) {
    const b = await dirBytes(dirFor(id));
    if (b === null) continue;
    bytes += b;
    dirs += 1;
  }
  const settled: UsageSnapshot = { version: 1, root: snap.root, bytes, dirs, measuredAt: snap.measuredAt, updatedAt: new Date().toISOString() };
  if (!(await writeSnapshot(settled))) return null;
  return { bytes, dirs, withinBudget: bytes <= budget };
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
    return new Set((await readdir(stemsRoot())).filter(n => n !== STEMS_MARKER));
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

// Read already-loaded likes synchronously. Loading them in the tagger child could create a
// second dedup secret; missing likes simply omit curation from the score.
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

// If priority lookup fails, return null for every dir and use mtime eviction. Dirs for tracks
// absent from the catalogue evict first. #1622.
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

// Evict by ascending stem priority, then mtime, until the byte budget fits. Report failedDirs
// and overBudgetBytes so callers can expose deletion failures; retry failed deletions next
// sweep. #1257.
export async function sweep(budget = budgetBytes(), { force = false }: { force?: boolean } = {}): Promise<{
  removed: number;
  freedBytes: number;
  failedDirs: number;
  overBudgetBytes: number;
  // Set when the sweep did nothing because the cache root has no marker (an
  // unmounted share): the message says why.
  offline?: string;
  // Set when no walk was made: the snapshot showed the cache inside its budget
  // ('snapshot'), or an analysis pass is writing and will settle it ('pass-running').
  skipped?: 'snapshot' | 'pass-running';
}> {
  const root = await stemsRootStatus({ readOnly: true });
  if (!root.online) {
    return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0, offline: root.message };
  }
  const before = await snapshotState();
  // The pass's own end-of-pass sweep is not "a pass running elsewhere".
  if (before.verdict === 'pass-running' && before.snap?.pending?.pid !== process.pid) {
    return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0, skipped: 'pass-running' };
  }
  if (!force && before.verdict === 'use' && before.snap && before.snap.bytes <= budget) {
    return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0, skipped: 'snapshot' };
  }
  const dirs = await scanDirs();
  let total = dirs.reduce((n, d) => n + d.bytes, 0);
  if (total <= budget) {
    await writeSnapshot(snapshotFromWalk(total, dirs.length));
    return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0 };
  }

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
  await writeSnapshot(snapshotFromWalk(total, dirs.length - removed));
  return { removed, freedBytes, failedDirs, overBudgetBytes: Math.max(0, total - budget) };
}
