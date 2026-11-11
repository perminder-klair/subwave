// The analyzer writes cached head/tail stems on the shared volume. The controller manages
// paths and evicts by the same priority the backfill uses.

import { access, constants, readdir, stat, rm, readFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as db from './library-db.js';
import * as likes from '../broadcast/likes.js';
import { evictQueuedLast, stemEvictionOrder, UNKNOWN_TRACK_PRIORITY } from './stem-priority.js';
import { mapPool } from '../util/async-pool.js';
import type { StemScanOpts } from './library-db.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import { randomUUID } from 'node:crypto';

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

// Walks of the cache root since start (scanDirs + cachedTrackIdSet). Tests
// read it to pin which paths walk the cache: on a NAS a full walk takes minutes.
let cacheWalks = 0;
export function _cacheWalksForTests(): number {
  return cacheWalks;
}

// One walk of the cache root -> per-dir bytes + newest mtime, shared by the
// sweep and the usage report. ENOENT-tolerant: the analyzer may be writing.
async function scanDirs(): Promise<Array<{ dir: string; bytes: number; mtimeMs: number }>> {
  cacheWalks += 1;
  let entries: string[];
  const root = stemsRoot();
  try {
    entries = await readdir(root);
  } catch {
    return []; // no cache dir yet
  }
  // Dot entries are never track dirs: the root marker, and the orphan purge's
  // .orphan-quarantine, whose few-KB inode size would otherwise rank it first
  // in the eviction order (no library row) and let an over-budget sweep
  // rm -rf the whole quarantine past its grace, while freeing far more than
  // the sweep counted. stemsRootStatus skips them the same way.
  entries = entries.filter(name => !name.startsWith('.'));
  const measured = await mapPool(entries, SCAN_CONCURRENCY, name => measureDir(path.join(root, name)));
  return measured.filter((d): d is { dir: string; bytes: number; mtimeMs: number } => d !== null);
}

// ---- usage snapshot -------------------------------------------------------
// A full walk stats every file of every track dir: hundreds of thousands of
// metadata reads on a large cache, which wakes a sleeping disk every hour and,
// on a network share, takes minutes. Nearly every hour nothing has changed, so
// the last walk's totals are kept in <stateDir>/stem-cache-usage.json and
// reused while they can be trusted:
// - the analysis pass writes stem dirs in bulk: it marks the snapshot
//   `pending` while it runs and adds the dirs it wrote when it ends;
// - a pick-time separation (broadcast/pick-stems.ts) writes one dir at a
//   time and adds what it grew at once (settleTrackWrite), against the
//   measurement it read before writing (beginTrackWrite);
// - evictions are made by sweep(), which rewrites the snapshot from its walk,
//   and by forgetStems() (a replaced file's stems), which measures the dirs it
//   drops and takes them off the totals (adjustUsage);
// - the orphan purge does the same for the dirs it moves into its quarantine
//   or releases from it. Its deletes change nothing here: the quarantine is
//   outside the cache total (scanDirs skips dot entries);
// - a change that cannot be counted exactly (a delete refused part-way, a dir
//   that cannot be measured, a pass writing right now) marks it `stale`
//   instead (markUsageStale): the next read walks, and until then the figure
//   stays readable for the budget field;
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
  // The cache changed outside the pass and the sweep: these are last-known totals.
  stale?: boolean;
  // Bytes in `bytes` the last over-budget sweep could not delete (folders this
  // user cannot open, sweep()). Only that sweep measures them; every writer
  // that keeps the totals keeps this with them, and a full walk, which does not
  // probe, drops it. Absent = none known. pick-stems-policy.ts budgetVeto
  // judges the rest, because the sweep leaves these out of its own budget check.
  // Set only through buildSnapshot, and read only through unevictableOf.
  unevictableBytes?: number;
}

// What writeSnapshot accepts: a snapshot buildSnapshot made. The brand exists
// only in the type, so a writer that assembles the totals field by field, or
// spreads a snapshot it read, does not compile until it goes through
// buildSnapshot and says what becomes of the stuck bytes (#2253).
declare const BUILT: unique symbol;
type BuiltSnapshot = UsageSnapshot & { readonly [BUILT]: true };

export type SnapshotVerdict = 'use' | 'walk' | 'pass-running';

// Pure seam (scripts/stem-cache-snapshot.test.ts): may this snapshot stand in
// for a walk, and why not? The reason is what a walk logs before it starts,
// so it comes from this one cascade rather than a second reading of the file.
export function judgeSnapshot(opts: {
  snap: UsageSnapshot | null;
  root: string;
  nowMs: number;
  pendingAlive: boolean;
}): { verdict: SnapshotVerdict; reason: string } {
  const { snap } = opts;
  const walk = (reason: string) => ({ verdict: 'walk' as const, reason });
  if (!snap) return walk('no stored size');
  if (snap.version !== 1 || snap.root !== opts.root) return walk('the stored size is for another cache root');
  if (!Number.isFinite(snap.bytes) || !Number.isFinite(snap.dirs)) return walk('the stored size is malformed');
  if (snap.pending) {
    const since = Date.parse(snap.pending.since);
    const fresh = Number.isFinite(since) && opts.nowMs - since < PENDING_MAX_AGE_MS;
    // A live pass settles the budget itself when it ends; a dead one may have
    // written dirs nobody counted.
    return opts.pendingAlive && fresh
      ? { verdict: 'pass-running', reason: 'a pass is writing stems' }
      : walk('a pass that wrote stems did not settle');
  }
  if (snap.stale) return walk('the stored size was marked stale');
  const measured = Date.parse(snap.measuredAt);
  if (!Number.isFinite(measured)) return walk('the stored size is malformed');
  if (opts.nowMs - measured > SNAPSHOT_MAX_AGE_MS) return walk('the stored size is over a day old');
  if (measured > opts.nowMs + 60_000) return walk('the stored size is dated in the future');
  return { verdict: 'use', reason: 'the stored size is current' };
}

export function snapshotVerdict(opts: Parameters<typeof judgeSnapshot>[0]): SnapshotVerdict {
  return judgeSnapshot(opts).verdict;
}

function snapshotPath(): string {
  return path.join(config.stateDir, 'stem-cache-usage.json');
}

// The one cleaning of the unevictable figure: a finite positive number, never
// above the total those bytes are part of, else 0 (none known). The file is
// hand-editable state, so a reader trusts nothing in it.
function cleanUnevictable(u: unknown, bytes: number): number {
  if (typeof u !== 'number' || !Number.isFinite(u) || u <= 0) return 0;
  return Math.min(u, Number.isFinite(bytes) ? Math.max(0, bytes) : 0);
}

// The snapshot's unevictable figure, cleaned: 0 when it has none a reader can use.
function unevictableOf(snap: UsageSnapshot): number {
  return cleanUnevictable(snap.unevictableBytes, snap.bytes);
}

// The one constructor of a snapshot to write. `unevictableBytes` is required:
// a writer that keeps the totals passes `unevictableOf(snap)` on, a walk passes
// 0, and the sweep passes what it measured. Whatever `fields` carries for it is
// replaced, and the figure is cleaned against the new `bytes`, so a total that
// shrank never leaves more stuck bytes than it holds.
function buildSnapshot(fields: UsageSnapshot, unevictableBytes: number): BuiltSnapshot {
  const out: UsageSnapshot = { ...fields };
  delete out.unevictableBytes;
  const stuck = cleanUnevictable(unevictableBytes, out.bytes);
  if (stuck > 0) out.unevictableBytes = stuck;
  return out as BuiltSnapshot;
}

async function readSnapshot(): Promise<UsageSnapshot | null> {
  try {
    return JSON.parse(await readFile(snapshotPath(), 'utf8')) as UsageSnapshot;
  } catch {
    return null;
  }
}

async function writeSnapshot(snap: BuiltSnapshot): Promise<boolean> {
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

// For a writer outside the pass and the sweep that cannot count what it
// changed exactly (adjustUsage below, when a dir could not be measured, a
// delete was refused part-way or a walk overlapped its changes; a pick-time
// separation whose snapshot could not take the addition): the stored totals no
// longer match the disk, so the next read walks instead of trusting them. The
// file stays, because the budget field reads it (storedUsage) and an operator
// about to lower the budget is better served by a flagged figure than by none:
// with no figure the warning and the confirm both go. Totals that cannot be
// marked must not outlive this, so a failed write removes them.
export async function markUsageStale(): Promise<void> {
  await noteUsageChange();
  const snap = await readSnapshot();
  if (!snap) return;
  const marked = await writeSnapshot(buildSnapshot({ ...snap, stale: true, updatedAt: new Date().toISOString() }, unevictableOf(snap)));
  if (!marked) await rm(snapshotPath(), { force: true }).catch(() => {});
}

// A walk takes minutes on a share, and a writer outside the pass and the sweep
// may change dirs under it: the walk may then have counted some of those
// changes and missed others. The snapshot file alone cannot tell the walk
// that happened, because such a writer leaves the file as it found it when
// there is none or when it is untrusted (adjustUsage). So every delta, applied
// or refused, first replaces this token (one more file beside the snapshot,
// shared across processes like it), and a walk that finds the token changed
// between its start and its end stores nothing it would trust (walkUsage,
// writeSweepSnapshot). A token that cannot be written is removed instead, which
// a walk that started with one also sees.
function usageChangesPath(): string {
  return path.join(config.stateDir, 'stem-cache-usage.changes');
}

async function readUsageChanges(): Promise<string> {
  return readFile(usageChangesPath(), 'utf8').catch(() => '');
}

async function noteUsageChange(): Promise<void> {
  try {
    await writeFileAtomic(usageChangesPath(), `${randomUUID()}\n`);
  } catch {
    await rm(usageChangesPath(), { force: true }).catch(() => {});
  }
}

// Test seam: runs between a walk's scan and its decision to store what it
// found, where a writer landing mid-walk would land.
let duringWalk: (() => Promise<void>) | null = null;
export function _duringWalkForTests(fn: (() => Promise<void>) | null): void {
  duringWalk = fn;
}

// Where a delta is counted from: the `measuredAt` of the snapshot a writer
// read before it started changing dirs (null: there was none). adjustUsage
// applies the delta only to that same measurement. A walk that lands while
// the writer is measuring and moving dirs (the hourly sweep, a read that found
// the snapshot untrusted) rewrites the totals from the disk as it found it,
// which may already count some of those changes: applying the delta on top
// would count them twice and leave a wrong size marked as trusted.
export async function usageBase(): Promise<string | null> {
  return (await readSnapshot())?.measuredAt ?? null;
}

// For a writer outside the pass and the sweep that knows exactly what it
// changed: move the stored totals by that much and keep them trusted. Marking
// them stale instead costs the next read a full walk, and on a network share
// holding tens of thousands of dirs that walk takes many minutes, during which
// an import's stems step starts no worker: one replaced file, or a night's
// purge, must not cost that. `measuredAt` is kept, so the daily full walk
// still comes due on time. Each case that can't take the delta:
// - no snapshot, or one the next read walks for anyway (stale, too old,
//   another root): left to that walk, untouched. A walk already in flight
//   learns of the delta from the change token instead (noteUsageChange);
// - `since` given and the snapshot is no longer that measurement (a walk ran
//   during the change, see usageBase): which of the changes it saw is
//   unknown, so it is marked stale;
// - a pass writing: the pass settles onto its own base, and a dir it wrote
//   could be among the ones moved, so it is marked stale, which makes the
//   settle walk;
// - this process could not save the snapshot last time (snapshotUntrusted):
//   another process may still trust the file, so it is marked stale there.
// The compare-and-set is a read then a write, not one atomic step, and its
// writers live in two processes (forgetStems in the tagger's, the purge, the
// sweep and pick-time settles in the controller's): one that writes between
// this read and this write is overwritten, or overwrites this, so one delta
// or one walk's figure is lost while the result stays trusted. The window is
// one small file read and one atomic write, the error is at most that one
// change, and the full walk due every SNAPSHOT_MAX_AGE_MS ends it.
export async function adjustUsage(
  delta: { bytes: number; dirs: number },
  { since }: { since?: string | null } = {},
): Promise<'adjusted' | 'stale' | 'unchanged'> {
  if (delta.bytes === 0 && delta.dirs === 0) return 'unchanged';
  // Whatever becomes of the delta, a walk in flight may hold part of it.
  await noteUsageChange();
  const snap = await readSnapshot();
  if (since !== undefined && (snap?.measuredAt ?? null) !== since) {
    if (!snap) return 'unchanged';
    await markUsageStale();
    return 'stale';
  }
  if (!snap) return 'unchanged';
  const verdict = snapshotVerdict({
    snap,
    root: stemsRoot(),
    nowMs: Date.now(),
    pendingAlive: snap.pending ? pidAlive(snap.pending.pid) : false,
  });
  if (verdict === 'walk') return 'unchanged';
  if (verdict !== 'use' || snapshotUntrusted || !Number.isFinite(delta.bytes) || !Number.isFinite(delta.dirs)) {
    await markUsageStale();
    return 'stale';
  }
  const saved = await writeSnapshot(buildSnapshot({
    ...snap,
    bytes: Math.max(0, snap.bytes + delta.bytes),
    dirs: Math.max(0, snap.dirs + delta.dirs),
    updatedAt: new Date().toISOString(),
  }, unevictableOf(snap)));
  if (!saved) {
    // Totals that cannot be updated must not outlive this, as in markUsageStale.
    await rm(snapshotPath(), { force: true }).catch(() => {});
    return 'stale';
  }
  return 'adjusted';
}

// What one track dir adds to the cache total, measured the way the walk
// measures it (measureDir), so an adjusted total equals a fresh walk's.
// Null when it cannot be read.
export async function measuredDirBytes(dir: string): Promise<number | null> {
  return (await measureDir(dir))?.bytes ?? null;
}

// What a writer outside the pass and the sweep (forgetStems, the orphan purge)
// changed in the cache total, counted one dir at a time with what each
// measured (measuredDirBytes). A dir that could not be measured, or a change
// whose size is unknown, makes the whole tally inexact, and an inexact tally
// marks the snapshot stale instead of moving it. Begun before the first
// change, so the delta is counted against that measurement (usageBase).
export class UsageTally {
  private bytes = 0;
  private dirs = 0;
  private exact = true;
  private constructor(private readonly since: string | null) {}

  static async begin(): Promise<UsageTally> {
    return new UsageTally(await usageBase());
  }

  /** A dir that joined (+1) or left (-1) the cache, with what it measured. */
  count(sign: 1 | -1, dirBytes: number | null): void {
    if (dirBytes === null) {
      this.exact = false;
      return;
    }
    this.bytes += sign * dirBytes;
    this.dirs += sign;
  }

  /** A change of unknown size, such as a delete refused part-way. */
  unknown(): void {
    this.exact = false;
  }

  /** Move the stored totals by the tally, or mark them stale when it is inexact. */
  async settle(): Promise<void> {
    if (!this.exact) await markUsageStale();
    else await adjustUsage({ bytes: this.bytes, dirs: this.dirs }, { since: this.since });
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

async function snapshotState(): Promise<{ snap: UsageSnapshot | null; verdict: SnapshotVerdict; reason: string }> {
  const snap = await readSnapshot();
  const { verdict, reason } = judgeSnapshot({
    snap,
    root: stemsRoot(),
    nowMs: Date.now(),
    pendingAlive: snap?.pending ? pidAlive(snap.pending.pid) : false,
  });
  if (snapshotUntrusted && verdict === 'use') return { snap, verdict: 'walk', reason: 'the stored size could not be saved' };
  return { snap, verdict, reason };
}

// A walk does not probe for stuck folders, so a plain walk passes 0; only the
// over-budget sweep, which probed, passes what it found.
function snapshotFromWalk(bytes: number, dirs: number, unevictableBytes: number): BuiltSnapshot {
  const now = new Date().toISOString();
  return buildSnapshot({ version: 1, root: stemsRoot(), bytes, dirs, measuredAt: now, updatedAt: now }, unevictableBytes);
}

async function walkUsage(): Promise<{ bytes: number; dirs: number }> {
  const changesBefore = await readUsageChanges();
  const before = await snapshotState();
  // On a network share this is minutes with nothing else to show, and a caller
  // such as an import's stems step waits on it: say so before and after.
  const t0 = Date.now();
  console.log(`[stem-cache] measuring the stem cache (${before.reason}): walking every stem folder…`);
  const scanned = await scanDirs();
  await duringWalk?.();
  const bytes = scanned.reduce((n, d) => n + d.bytes, 0);
  console.log(`[stem-cache] measured ${scanned.length} stem folders, ${(bytes / 1024 ** 3).toFixed(1)} GB, in ${Math.round((Date.now() - t0) / 1000)} s`);
  const after = await snapshotState();
  // A live pass owns the additive baseline. A read must not count its writes
  // into that baseline, including when the pass starts during this walk. A
  // writer that changed dirs during it (the snapshot moved, or the change
  // token did) may be half in this figure: nothing is stored, and the next
  // read walks again.
  if (before.verdict !== 'pass-running' && after.verdict !== 'pass-running'
    && JSON.stringify(before.snap) === JSON.stringify(after.snap)
    && (await readUsageChanges()) === changesBefore) {
    await writeSnapshot(snapshotFromWalk(bytes, scanned.length, 0));
  }
  return { bytes, dirs: scanned.length };
}

// One-scan usage summary. Callers needing more than one figure must use this
// rather than the singles below, or they pay (and can race) a walk per figure.
// Served from the snapshot when it can be trusted (see above); a running
// pass's snapshot is not, since dirs are being added under it.
// `unevictableBytes` is the part of `bytes` the last over-budget sweep could
// not delete; 0 after a walk, which does not probe. `bytes` still counts it,
// so the pass's headroom and the reported overage are unchanged.
export async function usage(): Promise<{ bytes: number; dirs: number; estTrackBytes: number; unevictableBytes: number }> {
  const { snap, verdict } = await snapshotState();
  if (verdict === 'use' && snap) {
    return { bytes: snap.bytes, dirs: snap.dirs, estTrackBytes: estimateTrackBytes(snap.bytes, snap.dirs), unevictableBytes: unevictableOf(snap) };
  }
  const { bytes, dirs } = await walkUsage();
  return { bytes, dirs, estTrackBytes: estimateTrackBytes(bytes, dirs), unevictableBytes: 0 };
}

// The STORED cache size, for a surface that must answer at once (the stem
// budget field). Never walks: a walk of a large cache on a network share
// takes minutes, and this is read whenever the Settings page opens. A
// snapshot the sweep would not trust (older than a day, a pass writing) is
// still reported, flagged, because an operator about to lower the budget is
// better served by an old figure with its age than by none. Null when there
// is no usable snapshot of THIS root.
export interface StoredUsage {
  bytes: number;
  dirs: number;
  estTrackBytes: number;
  /** Last full walk. */
  measuredAt: string;
  updatedAt: string;
  /** The sweep would use this figure as is (measured within a day, no pass writing). */
  fresh: boolean;
  /** An analysis pass is adding stems right now; the figure is a floor. */
  passRunning: boolean;
  /** The cache changed since this was measured by more than a writer could count (adjustUsage); the sweep re-measures it. */
  stale: boolean;
}

export async function storedUsage(): Promise<StoredUsage | null> {
  const { snap, verdict } = await snapshotState();
  if (!snap || snap.version !== 1 || snap.root !== stemsRoot()) return null;
  if (!Number.isFinite(snap.bytes) || !Number.isFinite(snap.dirs) || snap.bytes < 0 || snap.dirs < 0) return null;
  return {
    bytes: snap.bytes,
    dirs: snap.dirs,
    estTrackBytes: estimateTrackBytes(snap.bytes, snap.dirs),
    measuredAt: snap.measuredAt,
    updatedAt: snap.updatedAt,
    fresh: verdict === 'use',
    passRunning: verdict === 'pass-running',
    stale: snap.stale === true,
  };
}

// The analysis pass marks the snapshot while it may write stem dirs. Called
// after its headroom read, so that read could still use the snapshot.
export async function markPassPending(): Promise<boolean> {
  const { snap, verdict } = await snapshotState();
  if (verdict !== 'use' || !snap) {
    snapshotUntrusted = true;
    return false;
  }
  return writeSnapshot(buildSnapshot(
    { ...snap, pending: { pid: process.pid, since: new Date().toISOString() }, updatedAt: new Date().toISOString() },
    unevictableOf(snap),
  ));
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
// that rewrote one invalidates the snapshot and takes a full walk instead, as
// does one a purge marked stale mid-pass, since its base no longer holds.
// An untrusted settlement also invalidates old totals, even if its file remains.
export async function settlePassWrites(
  newTrackIds: Iterable<string>,
  budget = budgetBytes(),
  { rewroteExisting = false }: { rewroteExisting?: boolean } = {},
): Promise<{ bytes: number; dirs: number; withinBudget: boolean } | null> {
  const snap = await readSnapshot();
  const mine = snap?.pending?.pid === process.pid;
  const base = snapshotVerdict({ snap, root: stemsRoot(), nowMs: Date.now(), pendingAlive: true });
  if (snapshotUntrusted || rewroteExisting || !snap || !mine || base !== 'pass-running' || snap.stale) {
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
  // The pass adds dirs and deletes none outside its own sweep, so the stuck
  // bytes the last sweep found are still part of the total.
  const settled = buildSnapshot(
    { version: 1, root: snap.root, bytes, dirs, measuredAt: snap.measuredAt, updatedAt: new Date().toISOString() },
    unevictableOf(snap),
  );
  if (!(await writeSnapshot(settled))) return null;
  return { bytes, dirs, withinBudget: bytes <= budget };
}

// Bytes under one track's dir, null when it has none.
export async function trackDirBytes(trackId: string): Promise<number | null> {
  return dirBytes(dirFor(trackId));
}

// What a pick-time separation starts from, read before it writes: the dir's
// bytes, and the measurement the snapshot held (usageBase), which
// settleTrackWrite counts the growth against.
export interface TrackWriteBase { bytes: number | null; since: string | null }
export async function beginTrackWrite(trackId: string): Promise<TrackWriteBase> {
  const since = await usageBase();
  return { bytes: await dirBytes(dirFor(trackId)), since };
}

// After a pick-time separation: add what the track's dir grew by to the
// snapshot, so the hourly sweep's budget check counts it without a walk. The
// one delta rule is adjustUsage's: a snapshot that can't take the addition (a
// pass writing, whose settle owns the baseline, or totals this process could
// not save) is marked stale, one the next read walks for anyway is left to
// that walk. The growth is counted against the measurement read before the
// write began (beginTrackWrite): a walk that landed during the separation may
// have counted part of the dir already, and the full growth on top of it
// would count that part twice.
export async function settleTrackWrite(trackId: string, base: TrackWriteBase): Promise<void> {
  const after = await dirBytes(dirFor(trackId));
  const grew = (after ?? 0) - (base.bytes ?? 0);
  const newDir = base.bytes === null && after !== null;
  if (grew === 0 && !newDir) return;
  await adjustUsage({ bytes: grew, dirs: newDir ? 1 : 0 }, { since: base.since });
}

// Track ids with a stem dir on disk: one readdir, no per-dir walk. The analysis
// pass snapshots this to tell a rewrite from net-new growth (stemWriteDecision).
export async function cachedTrackIdSet(): Promise<Set<string>> {
  cacheWalks += 1;
  try {
    // Dot entries (the marker, the orphan quarantine) are not track ids.
    return new Set((await readdir(stemsRoot())).filter(n => !n.startsWith('.')));
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

// Drop the stem dirs of tracks whose file was replaced at the same path
// (library-db.clearTrackAudio cleared their stamps): the render is cache-hit-
// only (hasWindow), so stems cut from the old audio would otherwise keep
// playing under the new file. Never touches an offline root (an unmounted
// share). Best-effort, like the sweep: a dir that refuses is counted, and its
// cleared stamp has the backfill separate the track again either way.
export async function forgetStems(trackIds: readonly string[]): Promise<{ removed: number; failed: number; offline?: string }> {
  if (trackIds.length === 0) return { removed: 0, failed: 0 };
  const root = await stemsRootStatus({ readOnly: true });
  if (!root.online) return { removed: 0, failed: 0, offline: root.message };
  let removed = 0;
  let failed = 0;
  // Begun before the first delete: a walk landing during them makes the delta
  // unsafe to apply (usageBase).
  const tally = await UsageTally.begin();
  for (const id of trackIds) {
    const dir = dirFor(id);
    const there = await stat(dir).then(() => true, () => false);
    if (!there) continue;
    const bytes = await measuredDirBytes(dir);
    let gone = true;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch { gone = false; }
    gone = gone && await stat(dir).then(() => false, () => true);
    if (gone) {
      removed += 1;
      tally.count(-1, bytes);
    } else {
      failed += 1;
      // A delete refused part-way left some of the files: what it freed is unknown.
      tally.unknown();
    }
  }
  // The usage snapshot still counts those dirs' bytes, which would size the
  // backfill too small (headroomTracks). They were measured before the delete,
  // so the totals move by exactly that, and the next read needs no walk. What
  // cannot be counted marks the snapshot stale in the file, not just in this
  // process: the walk that drops stems is the tagger's, and whichever process
  // reads next must walk again.
  await tally.settle();
  return { removed, failed };
}

// Probed before any delete rather than learned from a failed one: a fresh unplayed
// track ranks below a stuck played one, so it would be gone before the sweep met the
// first folder it could not delete. rm's catch still covers what this can't see.
async function canDeleteInside(dir: string): Promise<boolean> {
  return access(dir, constants.W_OK | constants.X_OK).then(() => true, () => false);
}

// Evict by ascending stem priority, then mtime, until the byte budget fits. Report failedDirs
// and overBudgetBytes so callers can expose deletion failures; retry failed deletions next
// sweep. #1257. A folder that can't be deleted stays in the reported overage but leaves the
// budget check: counting it would delete every folder that can go, and free nothing it holds.
// `keepLast` names tracks still waiting to air, whose dirs go after every other
// (stem-priority.ts evictQueuedLast). Only pick-time stems passes one
// (pick-stems-policy.ts sweepKeepLast); without it the order is unchanged.
export async function sweep(
  budget = budgetBytes(),
  { force = false, keepLast }: { force?: boolean; keepLast?: ReadonlySet<string> } = {},
): Promise<{
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
  const changesBefore = await readUsageChanges();
  const dirs = await scanDirs();
  await duringWalk?.();
  const walkedFrom = { snap: before.snap, changes: changesBefore };
  let total = dirs.reduce((n, d) => n + d.bytes, 0);
  if (total <= budget) {
    await writeSweepSnapshot(walkedFrom, snapshotFromWalk(total, dirs.length, 0));
    return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0 };
  }

  const ordered = evictQueuedLast(stemEvictionOrder(withPriorities(dirs)), keepLast, d => path.basename(d.dir));
  const canGo = await mapPool(ordered, SCAN_CONCURRENCY, d => canDeleteInside(d.dir));
  const stuck = ordered.filter((_, i) => !canGo[i]);
  let removed = 0;
  let freedBytes = 0;
  let failedDirs = stuck.length;
  let unevictable = stuck.reduce((n, d) => n + d.bytes, 0);
  for (const d of ordered.filter((_, i) => canGo[i])) {
    if (total - unevictable <= budget) break;
    try {
      await rm(d.dir, { recursive: true, force: true });
      total -= d.bytes;
      freedBytes += d.bytes;
      removed += 1;
    } catch { failedDirs += 1; unevictable += d.bytes; /* best-effort — retry next sweep */ }
  }
  if (failedDirs > 0) {
    console.warn(
      `[stem-cache] ${failedDirs} folder(s) (${Math.round(unevictable / 1024 ** 2)} MB) cannot be deleted by this user ` +
      'and are left out of the budget check. Open them as their owner (docs/deployment.md).',
    );
  }
  // The stuck bytes go in the snapshot beside the total, so pick-time stems
  // (budgetVeto) can judge the part this sweep can evict, as it did above.
  await writeSweepSnapshot(walkedFrom, snapshotFromWalk(total, dirs.length - removed, unevictable));
  return { removed, freedBytes, failedDirs, overBudgetBytes: Math.max(0, total - budget) };
}

// The sweep's walk is minutes on a share. If another writer moved the stored
// snapshot meanwhile (the orphan purge or forgetStems adjusting it, a pick-time
// settle, a pass's pending mark), or noted a delta it left the snapshot
// without (the change token, noteUsageChange), the walk may or may not have
// seen that writer's dirs, so its total is written for the budget field but
// marked stale: the next read walks again rather than trust a figure that may
// count a change twice or miss it.
async function writeSweepSnapshot(
  from: { snap: UsageSnapshot | null; changes: string },
  walked: BuiltSnapshot,
): Promise<void> {
  const now = await readSnapshot();
  const overlapped = JSON.stringify(now) !== JSON.stringify(from.snap)
    || (await readUsageChanges()) !== from.changes;
  await writeSnapshot(overlapped ? buildSnapshot({ ...walked, stale: true }, unevictableOf(walked)) : walked);
}
