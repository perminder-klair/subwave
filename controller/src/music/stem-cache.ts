// The analyzer writes cached head/tail stems on the shared volume. The controller manages
// paths and evicts by the same priority the backfill uses.

import { access, constants, readdir, stat, rm, readFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as db from './library-db.js';
import * as likes from '../broadcast/likes.js';
import { evictQueuedLast, stemEvictionOrder, UNKNOWN_TRACK_PRIORITY } from './stem-priority.js';
import { HEAD_META, TAIL_META, UNKNOWN_STAMP, parseStemStamp, windowUsable, type StemStamp } from './stem-provenance.js';
import { mapPool } from '../util/async-pool.js';
import type { StemScanOpts } from './library-db.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import {
  _journalStepsForTests, appendLines, dropJournal, ensureJournal, newSessionId, readJournal, trimJournal, type JournalRead,
} from './stem-usage-journal.js';
import {
  closeLine, inFlightKey, journalAccounts, openLine, passOpenLine, procStartTime, settleDecision, unknownLine, walkReconcile,
  UNNAMED_DIRS, type InFlight, type JournalMark, type SessionDir, type WalkReconcile,
} from './stem-usage-policy.js';

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
// And the window must be cut from the recording the row measured (#2238,
// stem-provenance.ts): its stamp agrees with the other window's and with the
// row's tracks.file_size, read here so no caller can leave the check out
// (`expect.fileSize` overrides it, for tests; no library open reads unknown,
// which judges nothing). A mismatch is a plain miss: nothing is evicted here.
export async function hasWindow(
  trackId: string,
  window: StemWindow,
  expect: { fileSize?: number | null } = {},
): Promise<boolean> {
  try {
    const expectedFileSize = 'fileSize' in expect ? expect.fileSize : rowFileSize(trackId);
    const files = STEM_NAMES.map(s => stemPath(trackId, window, s));
    if (window === 'tail') files.push(path.join(dirFor(trackId), TAIL_META));
    const checks = await Promise.all(
      files.map(f => stat(f).then(st => st.size > 0, () => false)),
    );
    if (!checks.every(Boolean)) return false;
    const [own, other] = await Promise.all([
      readStemStamp(trackId, window),
      readStemStamp(trackId, window === 'head' ? 'tail' : 'head'),
    ]);
    // An unreadable stamp of its own is no evidence; the tail's sidecar is
    // the render's alignment, so an unreadable one is a miss as it always was
    // at render time. An unreadable other window is judged when it is read.
    if (own === 'unreadable') return false;
    return windowUsable({
      own: own ?? UNKNOWN_STAMP,
      other: other === 'unreadable' ? null : other,
      expectedFileSize,
    });
  } catch {
    return false;
  }
}

function rowFileSize(trackId: string): number | null {
  return db.getDb() ? db.trackFileSize(trackId) : null;
}

// A window's provenance stamp: null when its meta file is absent (a head from
// before the stamps), 'unreadable' when it is there but does not parse.
async function readStemStamp(trackId: string, window: StemWindow): Promise<StemStamp | null | 'unreadable'> {
  let text: string;
  try {
    text = await readFile(path.join(dirFor(trackId), window === 'head' ? HEAD_META : TAIL_META), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    return parseStemStamp(JSON.parse(text)) ?? 'unreadable';
  } catch {
    return 'unreadable';
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
  await step('walk:listed');
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
// - every other writer that changes a stem dir (a pick-time separation, a
//   replaced file's stems dropped by forgetStems, the orphan purge's moves, an
//   id rotation's renames, the sweep's own evictions) brackets each dir in the
//   usage journal, <stateDir>/stem-cache-usage.journal, and settles what it
//   measured against what the snapshot holds (StemDirWrites, below; the rules
//   are music/stem-usage-policy.ts). The snapshot records the journal position
//   it accounts for, and is trusted only while nothing past that position is
//   more than a write still running (#2317);
// - a walk (the sweep, or a read that found the snapshot untrusted) re-measures
//   at its end every dir the journal names since it began, and every dir still
//   being written, and stores its figure at the journal's end, holding what it
//   counted for the writes still open (`inFlight`), so a separation that
//   settles during or after it is counted against that. Before the journal, any
//   change during a walk left its figure stale, which with pick-time stems on
//   and a 16-minute walk on a share was most hours, in runs;
// - a change that cannot be counted exactly (a delete refused part-way, a
//   separation that timed out with the worker perhaps still writing) marks it
//   `stale` (markUsageStale): the next read walks, and until then the figure
//   stays readable for the budget field;
// - a writer that dies between its change and its close (a controller
//   restart mid-separation, a tagger child killed mid-forgetStems) leaves its
//   opening for good; the snapshot stops being trusted as soon as that
//   opening is not live (writerAlive: its pid gone, or reused by a process
//   with another start identity; or past OPEN_MAX_AGE_MS), whether it lies
//   past the position or the snapshot holds it in `inFlight` (#2352);
// - anything else (dirs deleted or copied in by hand, a pass that died before
//   settling) is caught by a full walk at least every SNAPSHOT_MAX_AGE_MS.
//
// Two processes share these files: the controller (the hourly sweep, pick-time
// separations, the purge, most reads) and the tagger child (forgetStems, id
// rotations, the analysis pass and its reads). In this process every
// read-and-write of the snapshot runs under one lock (underUsageLock); across
// the two, the journal's order is what keeps a figure from being trusted and
// wrong. The orderings, for a walk W and a writer X in either process (X opens
// a bracket, writes, closes it, and settles):
// - X opens and closes before W starts: W scans the result.
// - X opens before W starts and closes after W's end: W re-measures the open
//   dir and stores `inFlight` with it; X's settle counts its final against it.
// - X opens and closes during W: W re-measures the dir after the close.
// - X opens during W and closes after: as the second case.
// - X opens after W's last read of the journal: W counted the dir as it was
//   before the opening, which is X's base, and X's settle on W's figure counts
//   its final against its base.
// - X's settle lands on the old snapshot before W stores: W saw the close and
//   re-measured, so W's figure replaces a right one with a right one. Across
//   processes the other order can lose W's store to X's (X read the old
//   snapshot first): X's result is the old figure plus X's own change, which
//   is right at X's position, and whatever W re-measured past that position is
//   past it again, so the result is untrusted until a walk.
// - Two writers settling on one snapshot: each reads the journal after its
//   own close, so the later of the two sees the earlier's close past the
//   snapshot's position and stands down (settleDecision); the earlier's
//   position stops short of the later's close, so the result is untrusted.
// - Two writers in one dir: refused at the walk and at both settles.
// - A trim (W, after a trusted store, only one at a time) replaces the file:
//   every snapshot naming the old file stops being trusted, the openings still
//   running are carried, and lines that reach the old file late are copied or
//   appended again (stem-usage-journal.ts).
// - The journal missing, unreadable or unwritable: no figure is trusted (a
//   writer that cannot record its change removes the journal), today's walk.
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
  // An analysis pass that may be writing stem dirs right now. `start` is its
  // process's start identity (as on a journal opening, writerAlive): a pid
  // reused after the pass died, as under tini after a restart, must not keep
  // the pass "running" (and the hourly sweep standing down) for
  // PENDING_MAX_AGE_MS. A mark without one (written before #2352, or where
  // /proc cannot be read) is judged on its pid alone.
  pending?: { pid: number; since: string; start?: string };
  // The cache changed outside the pass and the sweep: these are last-known totals.
  stale?: boolean;
  // Bytes in `bytes` the last over-budget sweep could not delete (folders this
  // user cannot open, sweep()). Only that sweep measures them; every writer
  // that keeps the totals keeps this with them, and a full walk, which does not
  // probe, drops it. Absent = none known. pick-stems-policy.ts budgetVeto
  // judges the rest, because the sweep leaves these out of its own budget check.
  // Set only through buildSnapshot, and read only through unevictableOf.
  unevictableBytes?: number;
  // The usage journal position these totals account for. Absent: a snapshot
  // from before the journal, trusted only when the journal is first created
  // beside it (an upgrade), which stamps it.
  journal?: JournalMark;
  // For each bracket open at that position, what the totals counted for its dir.
  inFlight?: InFlight;
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
// The journal is judged after it (snapshotState), since a file read is needed.
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
  if (out.inFlight && Object.keys(out.inFlight).length === 0) delete out.inFlight;
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

// Every read-and-write of the snapshot in this process, in order. The walk's
// end (its last journal reads, the trim and the store) and a writer's settle
// never interleave here; across processes the journal's order covers them
// (header above).
let usageChain: Promise<unknown> = Promise.resolve();
let usageLockOn = true;
function underUsageLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!usageLockOn) return fn();
  const run = usageChain.then(fn, fn);
  usageChain = run.catch(() => {});
  return run;
}

// Test seams (scripts/stem-usage-orderings.test.ts): named points inside the
// walk, the settle and the trim, where a test running two of them at once
// decides which goes next, and the lock switched off so that two of them in
// one process interleave the way they would in two.
let usageStep: ((step: string) => Promise<void>) | null = null;
export function _usageStepsForTests(fn: ((step: string) => Promise<void>) | null, { lock = true }: { lock?: boolean } = {}): void {
  usageStep = fn;
  usageLockOn = lock;
  _journalStepsForTests(fn);
}
async function step(name: string): Promise<void> {
  await usageStep?.(name);
}

interface UsageState {
  snap: UsageSnapshot | null;
  verdict: SnapshotVerdict;
  reason: string;
  journal: JournalRead | null;
  /** The verdict on the snapshot alone (judgeSnapshot, and whether this process could save it), before the journal. */
  ownVerdict: SnapshotVerdict;
}

// The snapshot, the journal beside it, and whether the snapshot may stand in
// for a walk. Creates the journal when there is none. A snapshot written
// before the journal was (an upgrade: the build before #2317 kept a change
// token instead) is stamped at the journal's start, so the first sweep after
// an upgrade reuses it as it did before, and whatever was journaled since is
// judged as for any other snapshot. Called under the lock.
async function readUsageState(): Promise<UsageState> {
  let journal = await ensureJournal();
  let snap = await readSnapshot();
  const written = Date.parse(snap?.updatedAt ?? '');
  if (journal && snap && !snap.journal && !snap.pending && Number.isFinite(written) && written <= journal.createdMs) {
    const stamped = buildSnapshot({ ...snap, journal: { id: journal.id, upTo: journal.headerEnd } }, unevictableOf(snap));
    if (await writeSnapshot(stamped)) snap = stamped;
  }
  // A trim in the other process replaces the journal a moment before it
  // stores the snapshot that names the new one: look again before calling
  // that a mismatch.
  for (let i = 0; i < 2 && snap?.journal && journal && snap.journal.id !== journal.id; i += 1) {
    await new Promise(r => setTimeout(r, 25));
    journal = await readJournal();
    snap = await readSnapshot();
  }
  const judged = judgeSnapshot({
    snap,
    root: stemsRoot(),
    nowMs: Date.now(),
    pendingAlive: snap?.pending ? writerAlive(snap.pending.pid, snap.pending.start) : false,
  });
  let { verdict, reason } = judged;
  const ownVerdict = snapshotUntrusted && verdict === 'use' ? 'walk' : verdict;
  if (verdict === 'use' && !journalAccounts(snap?.journal, journal, { inFlight: snap?.inFlight, nowMs: Date.now(), alive: writerAlive })) {
    verdict = 'walk';
    reason = journal ? 'the cache changed in ways the stored size does not hold' : 'the usage journal could not be read';
  }
  if (snapshotUntrusted && verdict === 'use') {
    verdict = 'walk';
    reason = 'the stored size could not be saved';
  }
  return { snap, verdict, reason, journal, ownVerdict };
}

async function snapshotState(): Promise<UsageState> {
  return underUsageLock(readUsageState);
}

// For a change that cannot be counted exactly (a delete refused part-way; a
// pick-time separation that timed out, whose worker may still be writing):
// the stored totals no longer match the disk, so the next read walks instead
// of trusting them. The journal records it, so a walk running now cannot
// store a trusted figure across it either. The file stays, because the budget
// field reads it (storedUsage) and an operator about to lower the budget is
// better served by a flagged figure than by none: with no figure the warning
// and the confirm both go. Totals that cannot be marked must not outlive
// this, so a failed write removes them.
export async function markUsageStale(): Promise<void> {
  if (!(await appendLines([unknownLine(newSessionId())]))) await dropJournal();
  await underUsageLock(markSnapshotStale);
}

async function markSnapshotStale(): Promise<void> {
  const snap = await readSnapshot();
  if (!snap) return;
  const marked = await writeSnapshot(buildSnapshot({ ...snap, stale: true, updatedAt: new Date().toISOString() }, unevictableOf(snap)));
  if (!marked) await rm(snapshotPath(), { force: true }).catch(() => {});
}

// A change the journal could not record: no snapshot may be trusted on the
// journal's word until a walk. Removing the journal does that for a snapshot
// that names it; marking the snapshot stale does it for one from before the
// journal, which a new journal would otherwise stamp. If the journal cannot
// be removed either, the snapshot goes too. Called under the lock.
async function journalLost(): Promise<void> {
  if (!(await dropJournal())) await rm(snapshotPath(), { force: true }).catch(() => {});
  await markSnapshotStale();
}

// Test seam: runs between a walk's scan and its decision to store what it
// found, where a writer landing mid-walk would land.
let duringWalk: (() => Promise<void>) | null = null;
export function _duringWalkForTests(fn: (() => Promise<void>) | null): void {
  duringWalk = fn;
}

// What one track dir adds to the cache total, measured the way the walk
// measures it (measureDir), so an adjusted total equals a fresh walk's.
// Null when the walk would not count it (absent, or not readable).
export async function measuredDirBytes(dir: string): Promise<number | null> {
  return (await measureDir(dir))?.bytes ?? null;
}

// The writes of one writer outside the pass: each dir it changes is opened in
// the journal before the first change (touch, which then measures it), and at
// the end closed and measured again (settle), which moves the stored totals by
// exactly what changed, measured the way a walk measures, when the snapshot
// can take it (settleDecision); otherwise the snapshot is left untrusted, and
// the next read walks. A change of unknown size (unknown) marks it stale.
export class StemDirWrites {
  private readonly session = newSessionId();
  private readonly base = new Map<string, number | null>();
  private recorded = true;
  private inexact = false;

  /** Open `name` (a dir directly under the cache root) before its first change. */
  async touch(name: string): Promise<void> {
    if (this.base.has(name)) return;
    if (!(await appendLines([openLine(this.session, name, Date.now(), process.pid, OWN_START)]))) this.recorded = false;
    await step('write:opened');
    this.base.set(name, await measuredDirBytes(path.join(stemsRoot(), name)));
    await step('write:based');
  }

  /** A change whose size is unknown (a delete refused part-way). */
  unknown(): void {
    this.inexact = true;
  }

  get touched(): number {
    return this.base.size;
  }

  /** Close every dir and move the stored totals by what they changed. */
  async settle(): Promise<'adjusted' | 'untrusted' | 'unchanged'> {
    if (this.base.size === 0) return 'unchanged';
    const dirs: SessionDir[] = [];
    for (const [dir, base] of this.base) {
      dirs.push({ dir, base, final: await measuredDirBytes(path.join(stemsRoot(), dir)) });
    }
    if (!(await appendLines(dirs.map(d => closeLine(this.session, d.dir))))) this.recorded = false;
    await step('write:closed');
    if (!this.recorded) {
      await underUsageLock(journalLost);
      return 'untrusted';
    }
    if (this.inexact) {
      await markUsageStale();
      return 'untrusted';
    }
    return underUsageLock(async () => {
      const state = await readUsageState();
      await step('write:read');
      const snap = state.snap;
      // Judged without the journal: this writer's own closes lie past the
      // snapshot's position until it settles, and settleDecision reads them.
      // One the next read walks for anyway (none, stale, over a day old) is
      // left to that walk as it is.
      if (!snap || state.ownVerdict === 'walk') return 'untrusted';
      // A pass writing settles onto its own base, and a dir it wrote could be
      // among these: flagged stale, which makes its settle walk.
      if (state.ownVerdict === 'pass-running') {
        await markSnapshotStale();
        return 'untrusted';
      }
      const decision = settleDecision({
        mark: snap.journal,
        inFlight: snap.inFlight,
        journal: state.journal,
        session: this.session,
        dirs,
      });
      if (decision.kind === 'accounted') return 'unchanged';
      if (decision.kind === 'refuse') {
        // Untrusted already (this writer's closes lie past its position); the
        // flag says so to the budget field too.
        await markSnapshotStale();
        return 'untrusted';
      }
      const saved = await writeSnapshot(buildSnapshot({
        ...snap,
        bytes: Math.max(0, snap.bytes + decision.bytes),
        dirs: Math.max(0, snap.dirs + decision.dirs),
        updatedAt: new Date().toISOString(),
        journal: decision.mark,
        inFlight: decision.inFlight,
      }, unevictableOf(snap)));
      if (!saved) {
        // Totals that cannot be updated must not outlive this, as in markUsageStale.
        await rm(snapshotPath(), { force: true }).catch(() => {});
        return 'untrusted';
      }
      return decision.bytes === 0 && decision.dirs === 0 ? 'unchanged' : 'adjusted';
    });
  }

  /** Close every dir without counting: the change goes on unseen (a timed-out separation). */
  async abandon(): Promise<void> {
    if (this.base.size > 0) await appendLines([...this.base.keys()].map(d => closeLine(this.session, d)));
    await markUsageStale();
  }
}

// A process's start identity (stem-usage-policy.ts procStartTime), or null
// where /proc cannot be read (not Linux, or the process is gone).
function processStart(pid: number | 'self'): string | null {
  try {
    return procStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

// This process's start identity, carried on each journal opening it writes.
// Read once: a process's start time never changes.
const OWN_START = processStart('self');

// Is the writer of an opening still running? Its pid must name a live process
// and, when the opening carries a start identity, that process must have it:
// under tini a restarted controller usually gets its dead predecessor's pid,
// this process included, so the pid alone would call that writer alive
// (#2352). An identity that cannot be read back is not a match.
function writerAlive(pid: number, start: string | undefined): boolean {
  if (!pidAlive(pid)) return false;
  if (start === undefined) return true;
  const actual = pid === process.pid ? OWN_START : processStart(pid);
  return actual !== null && actual === start;
}

// The pending mark this process writes, and whether a mark is this process's
// own: its pid, and its start identity when the mark carries one, so a
// restarted process with its predecessor's pid never takes that pass's mark
// for its own.
function ownPendingMark(): NonNullable<UsageSnapshot['pending']> {
  return { pid: process.pid, since: new Date().toISOString(), ...(OWN_START !== null ? { start: OWN_START } : {}) };
}

function isOwnPending(p: UsageSnapshot['pending']): boolean {
  return p?.pid === process.pid && (p.start === undefined || p.start === OWN_START);
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

// A walk does not probe for stuck folders, so a plain walk passes 0; only the
// over-budget sweep, which probed, passes what it found.
function snapshotFromWalk(
  bytes: number,
  dirs: number,
  unevictableBytes: number,
  at?: { journal: JournalMark; inFlight: InFlight },
): BuiltSnapshot {
  const now = new Date().toISOString();
  return buildSnapshot({ version: 1, root: stemsRoot(), bytes, dirs, measuredAt: now, updatedAt: now, ...at }, unevictableBytes);
}

// The end of a walk that started at `before` and found `byName` (each dir's
// bytes, null for a dir it would not count), under the lock: re-measure what
// the journal says changed under it, then store the figure at the journal's
// end, or, if the journal cannot vouch for it, as before the journal: a sweep
// stores it flagged stale, a read stores nothing. Returns the totals.
async function finishWalk(o: {
  before: UsageState;
  byName: Map<string, number | null>;
  mode: 'read' | 'sweep';
  unevictable: number;
}): Promise<{ bytes: number; dirs: number }> {
  const totals = () => {
    let bytes = 0;
    let dirs = 0;
    for (const v of o.byName.values()) {
      if (v === null) continue;
      bytes += v;
      dirs += 1;
    }
    return { bytes, dirs };
  };
  const now = await readUsageState();
  // A live pass owns the additive baseline: a read must not count its writes
  // into that baseline, including when the pass starts during this walk.
  if (o.mode === 'read' && (o.before.verdict === 'pass-running' || now.verdict === 'pass-running')) return totals();
  const start = o.before.journal;
  let read = now.journal;
  let plan: WalkReconcile = { ok: false, reason: 'the cache kept changing while it was re-measured' };
  let stable = false;
  for (let round = 0; round < 3 && !stable; round += 1) {
    plan = walkReconcile(start?.id ?? null, start?.end ?? 0, read, Date.now(), writerAlive);
    if (!plan.ok) break;
    for (const name of plan.remeasure) o.byName.set(name, await measuredDirBytes(path.join(stemsRoot(), name)));
    await step('walk:remeasured');
    const again = await readJournal();
    stable = Boolean(again && read && again.id === read.id && again.end === read.end);
    read = again;
  }
  const t = totals();
  if (!plan.ok || !stable || !read) {
    if (o.mode === 'sweep') {
      await writeSnapshot(buildSnapshot({ ...snapshotFromWalk(t.bytes, t.dirs, 0), stale: true }, o.unevictable));
    }
    return t;
  }
  const inFlight: InFlight = {};
  for (const w of plan.open) inFlight[inFlightKey(w.session, w.dir)] = o.byName.get(w.dir) ?? null;
  await step('walk:store');
  const trimmed = await trimJournal(read, plan.open);
  if (trimmed) await step('walk:trimmed');
  const journal = trimmed ? { id: trimmed.journal.id, upTo: trimmed.upTo } : { id: read.id, upTo: read.end };
  await writeSnapshot(snapshotFromWalk(t.bytes, t.dirs, o.unevictable, { journal, inFlight }));
  await step('walk:stored');
  return t;
}

async function walkUsage(): Promise<{ bytes: number; dirs: number }> {
  await step('walk:start');
  const before = await snapshotState();
  // On a network share this is minutes with nothing else to show, and a caller
  // such as an import's stems step waits on it: say so before and after.
  const t0 = Date.now();
  console.log(`[stem-cache] measuring the stem cache (${before.reason}): walking every stem folder…`);
  const scanned = await scanDirs();
  await duringWalk?.();
  await step('walk:scanned');
  const bytes = scanned.reduce((n, d) => n + d.bytes, 0);
  console.log(`[stem-cache] measured ${scanned.length} stem folders, ${(bytes / 1024 ** 3).toFixed(1)} GB, in ${Math.round((Date.now() - t0) / 1000)} s`);
  const byName = new Map<string, number | null>(scanned.map(d => [path.basename(d.dir), d.bytes]));
  return underUsageLock(() => finishWalk({ before, byName, mode: 'read', unevictable: 0 }));
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
  /** The cache changed since this was measured by more than a writer could count; the sweep re-measures it. */
  stale: boolean;
}

export async function storedUsage(): Promise<StoredUsage | null> {
  const { snap, verdict, journal } = await snapshotState();
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
    stale: snap.stale === true || !journalAccounts(snap.journal, journal, { inFlight: snap.inFlight, nowMs: Date.now(), alive: writerAlive }),
  };
}

// The pass that marked the snapshot in this process, or that was refused the
// mark: its journal opening, closed when it settles.
let passSession: string | null = null;

// The analysis pass marks the snapshot while it may write stem dirs. Called
// after its headroom read, so that read could still use the snapshot. The
// journal records the pass either way (an opening of dirs it does not name),
// so that no walk in the other process stores a trusted figure while it
// writes: with the mark refused (the snapshot was not trusted already), there
// is no pending mark to stop one, and a walk would store a partial figure.
export async function markPassPending(): Promise<boolean> {
  passSession = newSessionId();
  const recorded = await appendLines([passOpenLine(passSession, Date.now(), process.pid, OWN_START)]);
  return underUsageLock(async () => {
    const { snap, verdict } = await readUsageState();
    if (!recorded || verdict !== 'use' || !snap) {
      snapshotUntrusted = true;
      if (!recorded) await journalLost();
      return false;
    }
    return writeSnapshot(buildSnapshot(
      { ...snap, pending: ownPendingMark(), updatedAt: new Date().toISOString() },
      unevictableOf(snap),
    ));
  });
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
// does one a purge marked stale mid-pass, since its base no longer holds, or
// one another writer changed the cache under (its close lies past the
// snapshot's position: settleDecision refuses).
// An untrusted settlement also invalidates old totals, even if its file remains.
export async function settlePassWrites(
  newTrackIds: Iterable<string>,
  budget = budgetBytes(),
  { rewroteExisting = false }: { rewroteExisting?: boolean } = {},
): Promise<{ bytes: number; dirs: number; withinBudget: boolean } | null> {
  const session = passSession;
  passSession = null;
  const closed = session ? await appendLines([closeLine(session, UNNAMED_DIRS)]) : true;
  return underUsageLock(async () => {
    if (!closed) await journalLost();
    const snap = await readSnapshot();
    const journal = await readJournal();
    const mine = isOwnPending(snap?.pending);
    const base = snapshotVerdict({ snap, root: stemsRoot(), nowMs: Date.now(), pendingAlive: true });
    if (snapshotUntrusted || rewroteExisting || !snap || !mine || base !== 'pass-running' || snap.stale || !session || !closed) {
      snapshotUntrusted = true;
      return null;
    }
    // Past the pass's own opening and close, as a writer of no named dir.
    const decision = settleDecision({ mark: snap.journal, inFlight: snap.inFlight, journal, session, dirs: [] });
    if (decision.kind !== 'apply') {
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
      {
        version: 1, root: snap.root, bytes, dirs, measuredAt: snap.measuredAt, updatedAt: new Date().toISOString(),
        journal: decision.mark, inFlight: decision.inFlight,
      },
      unevictableOf(snap),
    );
    if (!(await writeSnapshot(settled))) return null;
    return { bytes, dirs, withinBudget: bytes <= budget };
  });
}

// Bytes under one track's dir, null when it has none.
export async function trackDirBytes(trackId: string): Promise<number | null> {
  return dirBytes(dirFor(trackId));
}

// A pick-time separation's writes (broadcast/pick-stems.ts): opened before
// the worker is asked, so a walk that lands during the separation knows the
// dir is being written, and settled when it answers (settleTrackWrite), which
// adds what the dir grew by against whatever the snapshot holds for it then.
export async function beginTrackWrite(trackId: string): Promise<StemDirWrites> {
  const writes = new StemDirWrites();
  await writes.touch(path.basename(dirFor(trackId)));
  return writes;
}

// After a pick-time separation: add what the track's dir grew by to the
// snapshot, so the hourly sweep's budget check counts it without a walk.
export async function settleTrackWrite(_trackId: string, writes: StemDirWrites): Promise<void> {
  await writes.settle();
}

// A separation that timed out: the worker may still be writing, so nothing
// measured now is its final. The snapshot is marked stale, as before.
export async function abandonTrackWrite(writes: StemDirWrites): Promise<void> {
  await writes.abandon();
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
  // Each dir is opened in the usage journal before its delete and measured,
  // so a walk running meanwhile (the tagger's or the controller's) knows to
  // measure it again, and the totals move by exactly what went.
  const writes = new StemDirWrites();
  for (const id of trackIds) {
    const dir = dirFor(id);
    const there = await stat(dir).then(() => true, () => false);
    if (!there) continue;
    await writes.touch(path.basename(dir));
    let gone = true;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch { gone = false; }
    gone = gone && await stat(dir).then(() => false, () => true);
    if (gone) {
      removed += 1;
    } else {
      failed += 1;
      // A delete refused part-way left some of the files: what it freed is unknown.
      writes.unknown();
    }
  }
  // The usage snapshot still counts those dirs' bytes, which would size the
  // backfill too small (headroomTracks). They were measured before and after
  // the delete, so the totals move by exactly that, and the next read needs no
  // walk. What cannot be counted marks the snapshot stale in the file, not just
  // in this process: the walk that drops stems is the tagger's, and whichever
  // process reads next must walk again.
  await writes.settle();
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
  await step('walk:start');
  const before = await snapshotState();
  // The pass's own end-of-pass sweep is not "a pass running elsewhere".
  if (before.verdict === 'pass-running' && !isOwnPending(before.snap?.pending)) {
    return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0, skipped: 'pass-running' };
  }
  if (!force && before.verdict === 'use' && before.snap && before.snap.bytes <= budget) {
    return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0, skipped: 'snapshot' };
  }
  const dirs = await scanDirs();
  await duringWalk?.();
  await step('walk:scanned');
  const byName = (kept: typeof dirs) => new Map<string, number | null>(kept.map(d => [path.basename(d.dir), d.bytes]));
  let total = dirs.reduce((n, d) => n + d.bytes, 0);
  if (total <= budget) {
    await underUsageLock(() => finishWalk({ before, byName: byName(dirs), mode: 'sweep', unevictable: 0 }));
    return { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0 };
  }

  const ordered = evictQueuedLast(stemEvictionOrder(withPriorities(dirs)), keepLast, d => path.basename(d.dir));
  const canGo = await mapPool(ordered, SCAN_CONCURRENCY, d => canDeleteInside(d.dir));
  const stuck = ordered.filter((_, i) => !canGo[i]);
  let removed = 0;
  let freedBytes = 0;
  let failedDirs = stuck.length;
  let unevictable = stuck.reduce((n, d) => n + d.bytes, 0);
  // Each eviction is bracketed in the usage journal like any other writer's
  // change, so a walk running in the other process measures the dir again
  // rather than store a figure that still counts it. This walk sees its own
  // brackets too, and re-measures those dirs as gone.
  const session = newSessionId();
  let recorded = true;
  const evicted = new Set<string>();
  for (const d of ordered.filter((_, i) => canGo[i])) {
    if (total - unevictable <= budget) break;
    const name = path.basename(d.dir);
    if (!(await appendLines([openLine(session, name, Date.now(), process.pid, OWN_START)]))) recorded = false;
    try {
      await rm(d.dir, { recursive: true, force: true });
      total -= d.bytes;
      freedBytes += d.bytes;
      removed += 1;
      evicted.add(d.dir);
    } catch { failedDirs += 1; unevictable += d.bytes; /* best-effort — retry next sweep */ }
    if (!(await appendLines([closeLine(session, name)]))) recorded = false;
  }
  if (failedDirs > 0) {
    console.warn(
      `[stem-cache] ${failedDirs} folder(s) (${Math.round(unevictable / 1024 ** 2)} MB) cannot be deleted by this user ` +
      'and are left out of the budget check. Open them as their owner (docs/deployment.md).',
    );
  }
  // The stuck bytes go in the snapshot beside the total, so pick-time stems
  // (budgetVeto) can judge the part this sweep can evict, as it did above.
  await underUsageLock(async () => {
    if (!recorded) await journalLost();
    await finishWalk({ before, byName: byName(dirs.filter(d => !evicted.has(d.dir))), mode: 'sweep', unevictable });
  });
  return { removed, freedBytes, failedDirs, overBudgetBytes: Math.max(0, total - budget) };
}
