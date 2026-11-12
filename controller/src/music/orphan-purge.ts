// Orphan-stem purge, IO layer.
//
// planOrphanPurge / planQuarantinePurge (orphan-purge-pure.ts) decide; this
// file performs the moves on the share and reports. Rules the IO must keep:
//
// - An orphan is a dir that READS as stems (isStemDirListing), not just one the
//   library has no id for: a share holds things SUB/WAVE never wrote, and those
//   are neither moved nor, should an earlier build have moved one, aged out.
// - NEVER delete an orphan directly. Orphans MOVE into <root>/.orphan-quarantine
//   (a dot-directory, so scanDirs and the marker walk ignore it), and only a
//   quarantine past the grace period is deleted. The quarantine is a move on
//   the same filesystem, so it is atomic and costs no copy — the property
//   root-squashed NFS shares need. The one delete inside the grace: an id that
//   is quarantined already gives way to the newer live copy of that same id,
//   which starts its own grace, so the track never holds less than a week.
// - A quarantine whose id is in the library again is RELEASED back (the live
//   slot is free: a quarantine is a move, so exactly one copy exists), and a
//   complete set stamps the row's stems_at. If a fresh analysis already took
//   the slot the quarantine is superseded and simply ages out — never merged
//   over the new copy. A release brings blends back, it does not save the
//   separation (orphan-purge-pure.ts says why).
// - Only the SAME AUDIO is released: the stems' tail-meta.json duration must
//   match the returning row's (sameAudio), or the id may have come back as a
//   different recording at the same path (#2224). No evidence on either side,
//   a head-only set included, holds the release, and the entry ages out.
// - Quarantine age comes from an `.orphaned-at` sidecar written at move time
//   (the move itself only touches ctime, but writing the sidecars bumps the
//   dir's mtime, and the stem-priority lesson is that cache mtimes lie). The
//   mtime is never a fallback: a rename keeps the dir's old mtime, so a fresh
//   quarantine would read as days old and be deleted on the next pass. A move
//   whose sidecar cannot be written is undone (counted as failed), and a
//   quarantine whose sidecar is missing or unreadable starts its grace NOW
//   (stamped by the next confirmed pass): later, never sooner.
// - Dirs touched in the last hour are left alone: the analyzer writes stems
//   into a fresh dir, and a purge must never eat an in-flight set.
// - An id still rotating (the id_rotation_journal holds it) is known: its dir is
//   the rename's to move, and libraryIds says why that matters.
// - An empty id set is REFUSED, not treated as an empty library. The only
//   cheap way to get zero ids is a closed or half-open database, and quarantining
//   a whole cache on that reading is exactly the mass deletion quarantine exists
//   to survive.
// - Quarantine bytes sit OUTSIDE the byte budget, on purpose: scanDirs skips the
//   dot-dir, so the sweep neither counts nor evicts them. The budget says how
//   many stems the cache may keep for blends, and the sweep cannot evict a
//   quarantine without breaking its grace, so if those bytes counted, the only
//   way back under budget would be evicting live tracks to pay for dead ones.
//   The grace bounds the quarantine instead: disk use can reach the budget plus
//   a week of orphans, so leave that headroom on a small share. With the daily
//   pass off the week only ends at the next manual pass.
// - Delete failures are counted and reported, never thrown — a purge that
//   cannot delete on a squashed share must keep running and keep saying so.
// - The moves keep the usage snapshot (stem-cache's cached walk totals) true:
//   each moved dir is measured, and the totals move by exactly that
//   (stemCache.adjustUsage), so the next read needs no walk of the cache. The
//   delta applies only to the measurement the pass started from: a walk that
//   lands during the moves marks the snapshot stale instead (usageBase).
//   Deletes from the quarantine change nothing there, since the quarantine is
//   outside the total. A move that cannot be measured marks the snapshot stale
//   instead, so the next sweep re-measures, while the budget field keeps a
//   flagged figure and its confirm.
// - One confirmed pass at a time (the cron, a manual confirm): a second one
//   is refused while the first runs, so two never interleave their moves and
//   each report is what its own pass did. A release that lands on a live slot
//   an analyzer mkdir just created replaces that empty dir (rename onto an
//   empty dir), and onto a non-empty one fails and is counted.
// - The automatic pass (runScheduledOrphanPurge) refuses a plan above
//   AUTO_MAX_SHARE of the cache and leaves it, and that night's aged deletes,
//   to an operator's confirm. It still releases what came back, and it stamps
//   each quarantine's name like the manual one.

import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mapPool } from '../util/async-pool.js';
import * as db from './library-db.js';
import * as stemCache from './stem-cache.js';
import { resolveOrphanNames, writeNameSidecar, type OrphanTrackName } from './orphan-names.js';
import {
  exceedsAutoCeiling,
  IN_FLIGHT_MS,
  isStemDirListing,
  ORPHANED_AT,
  planOrphanPurge,
  planQuarantinePurge,
  QUARANTINE_DIR,
  sameAudio,
  TAIL_META,
  type QuarantineEntry,
} from './orphan-purge-pure.js';

export { IN_FLIGHT_MS };

// Set while a confirmed pass runs; a second confirmed pass is refused.
let confirmedPassRunning = false;

export interface PurgeReport {
  dryRun: boolean;
  /** Cache dirs whose track is still in the library. */
  keptCount: number;
  /** Orphans moved into the quarantine (dry run: would move). */
  quarantined: number;
  quarantinedNames: string[];
  /** Quarantine entries moved back to the live cache (dry run: would move). */
  released: string[];
  /** Quarantine entries deleted (dry run: would delete). */
  deletedCount: number;
  deletedNames: string[];
  /** Quarantine entries inside the grace period. */
  agingCount: number;
  /** Quarantines whose id is back in the library while the live slot is taken. */
  supersededCount: number;
  /** Quarantines whose id is back with the live slot free, held because the
   *  stems are not proven to be the returning audio: a duration that differs,
   *  or none to compare (a head-only set). They age out like any other. */
  mismatchedCount: number;
  /** Cache dirs skipped as in-flight (written within IN_FLIGHT_MS). */
  inFlight: number;
  /** Moves/deletes that failed this pass (permissions, squashed roots). */
  failed: number;
  /** Everything in the quarantine, whatever a pass would do with it. */
  quarantineEntries: number;
  /** True when the pass refused to run; `reason` says why. */
  refused?: boolean;
  reason?: string;
  /** Dry run: why the automatic pass would refuse this plan. A manual confirm
   *  still makes it, so the dry run itself is not refused. */
  autoRefusal?: string;
  /** Bytes freed by deleted quarantines (quarantining itself frees nothing). */
  freedBytes: number;
  offline?: string;
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { total += await dirBytes(path.join(dir, e.name)); continue; }
      try { total += (await stat(path.join(dir, e.name))).size; } catch { /* vanished mid-scan */ }
    }
  } catch { /* vanished mid-scan */ }
  return total;
}

// Delete a dir and say what really went: a delete refused part-way (a squashed
// share) leaves files behind, and those are not reclaimed space.
async function deleteDir(dir: string): Promise<{ gone: boolean; freedBytes: number }> {
  const before = await dirBytes(dir);
  let removed = true;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch { removed = false; }
  const gone = await stat(dir).then(() => false, () => true);
  if (removed && gone) return { gone: true, freedBytes: before };
  return { gone: false, freedBytes: gone ? 0 : Math.max(0, before - await dirBytes(dir)) };
}

// Quarantine age from the sidecar written at move time, or null when it is
// missing or unreadable. Never the dir's mtime (see the header): the caller
// reads null as "quarantined now".
async function quarantinedAgeMs(entryDir: string, now: number): Promise<number | null> {
  try {
    const stamped = Number(await readFileSafe(path.join(entryDir, ORPHANED_AT)));
    if (Number.isFinite(stamped) && stamped > 0) return Math.max(0, now - stamped);
  } catch { /* unreadable: no age */ }
  return null;
}

async function readFileSafe(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8');
}

// The decoded duration the stems were cut from, as the analyzer recorded it in
// tail-meta.json. Unread or absent (a head-only set): undefined, which
// sameAudio reads as no evidence.
async function stemsDurationSec(entryDir: string): Promise<unknown> {
  try {
    return (JSON.parse(await readFileSafe(path.join(entryDir, TAIL_META))) as { duration_sec?: unknown } | null)?.duration_sec;
  } catch {
    return undefined;
  }
}

// The returning row's duration. A library that cannot answer gives null, and
// the release it was asked for is held.
function storedDurationSec(id: string): number | null {
  try {
    return db.getTrack(id)?.durationSec ?? null;
  } catch {
    return null;
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return []; // no quarantine yet
  }
}

// The ids a pass counts as the library's. An id rotation commits the new ids
// first and renames the dirs afterwards, one at a time, and its journal stays
// open until that is done. So an old id in the journal still owns its dir: read
// as an orphan it would be quarantined out from under the rename, the track
// would keep a stems_at with nothing behind it, and absence alone never brings
// a track back into the backfill. A journal that cannot be read throws, so the
// pass stops rather than reading that as "nothing is rotating".
function libraryIds(knownIds: Iterable<string>, rotating = db.pendingIdRotations()): Set<string> {
  return new Set([...knownIds, ...rotating.keys()]);
}

async function readsAsStems(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return isStemDirListing(entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() })));
  } catch {
    return false; // vanished mid-walk
  }
}

/**
 * One walk of the cache root, shared by the pass and the panel's track list so
 * the two never disagree. Only an orphan is read at all: a known id is kept
 * whatever its age or contents, so the walk stats and lists just the unknown
 * dirs, in parallel, which keeps a 76k-dir share from costing one round trip
 * per track. Throws when the root cannot be read.
 */
async function walkCacheRoot(root: string, known: ReadonlySet<string>, now: number, inFlightMs: number) {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name);
  const kept = names.filter(name => known.has(name));
  const unknown = names.filter(name => !known.has(name));
  const verdicts = await mapPool(unknown, stemCache.SCAN_CONCURRENCY, async (name) => {
    const mtimeMs = await stat(path.join(root, name)).then(st => st.mtimeMs, () => null);
    if (mtimeMs == null) return 'gone'; // vanished mid-walk
    if (now - mtimeMs < inFlightMs) return 'in-flight';
    return (await readsAsStems(path.join(root, name))) ? 'orphan' : 'foreign';
  });
  return {
    kept,
    orphans: unknown.filter((_, i) => verdicts[i] === 'orphan'),
    inFlight: verdicts.filter(v => v === 'in-flight').length,
  };
}

/** The orphan dirs a pass would quarantine right now, for the panel's list. */
export async function listOrphanDirNames(knownIds: ReadonlySet<string>, now = Date.now()): Promise<string[]> {
  const status = await stemCache.stemsRootStatus({ readOnly: true });
  if (!status.online) return [];
  try {
    return (await walkCacheRoot(stemCache.stemsRoot(), libraryIds(knownIds), now, IN_FLIGHT_MS)).orphans;
  } catch {
    return [];
  }
}

export function listQuarantineDirNames(): Promise<string[]> {
  return listDirs(path.join(stemCache.stemsRoot(), QUARANTINE_DIR));
}

/**
 * One purge pass. `knownIds` is the library's full id set — the caller reads
 * it from the library DB; tests inject it. Unconfirmed is a pure dry run:
 * every branch of the plan is computed, nothing on disk is touched.
 */
export async function runOrphanPurge(opts: {
  knownIds: readonly string[];
  confirm: boolean;
  now?: number;
  inFlightMs?: number;
  quarantineDir?: string;
  graceMs?: number;
  /** Optional: display names for the dirs being quarantined. Called lazily
   *  once (only when a confirmed pass will actually move something), and what
   *  it returns is stamped into each quarantine as `.track-meta.json` so the
   *  name outlives the log retention that produced it. */
  resolveNames?: (ids: string[]) => Promise<ReadonlyMap<string, OrphanTrackName>>;
  /** The automatic pass: refuse a plan above AUTO_MAX_SHARE of the cache. */
  automatic?: boolean;
  /** The duration in seconds of the library row with this id, for a release's
   *  sameAudio check. The library DB by default; tests inject it. */
  rowDurationSec?: (id: string) => number | null;
}): Promise<PurgeReport> {
  if (!opts.confirm) return purgePass(opts);
  if (confirmedPassRunning) {
    return { ...emptyReport(false), refused: true, reason: 'another purge pass is running' };
  }
  confirmedPassRunning = true;
  try {
    return await purgePass(opts);
  } finally {
    confirmedPassRunning = false;
  }
}

/** A pass in one line, for the booth log: the daily tick and a manual press word
 *  it the same way. */
export function purgeSummary(r: PurgeReport): string {
  const failed = r.failed ? `, ${r.failed} failed (check ownership on the stems share)` : '';
  if (r.refused) return `refused — ${r.reason}${r.released.length ? `, released ${r.released.length}` : ''}${failed}`;
  return `quarantined ${r.quarantined}, released ${r.released.length}, deleted ${r.deletedCount}`
    + ` (${Math.round(r.freedBytes / 1_000_000)} MB freed)`
    + failed
    + (r.mismatchedCount ? `, ${r.mismatchedCount} back in the library but held (not proven the same audio)` : '')
    + (r.inFlight ? `, ${r.inFlight} in-flight dir(s) skipped` : '');
}

function emptyReport(dryRun: boolean): PurgeReport {
  return {
    dryRun, keptCount: 0, quarantined: 0, quarantinedNames: [], released: [],
    deletedCount: 0, deletedNames: [], agingCount: 0, supersededCount: 0, mismatchedCount: 0, inFlight: 0, failed: 0,
    quarantineEntries: 0, freedBytes: 0,
  };
}

async function purgePass(opts: Parameters<typeof runOrphanPurge>[0]): Promise<PurgeReport> {
  const now = opts.now ?? Date.now();
  const empty = emptyReport(!opts.confirm);
  const rootStatus = await stemCache.stemsRootStatus({ readOnly: true });
  const root = stemCache.stemsRoot();
  const qu = opts.quarantineDir ?? path.join(root, QUARANTINE_DIR);
  const quExists = await stat(qu).then(st => st.isDirectory(), () => false);
  if (!rootStatus.online) {
    // "Offline" normally means an unmounted share, and then the purge must do
    // nothing. But a quarantine that is visible proves the share IS mounted
    // (a marker can be lost while entries age): in that reading only the aged
    // delete runs — quarantining NEW dirs, or releasing old ones, into a share
    // we cannot vouch for stays refused.
    if (!quExists) return { ...empty, refused: true, reason: 'offline', offline: rootStatus.message };
  }

  if (opts.knownIds.length === 0) {
    return { ...empty, refused: true, reason: 'empty library id set: refusing (a closed or half-loaded database must never quarantine the cache)' };
  }
  const rotating = db.pendingIdRotations();
  const known = libraryIds(opts.knownIds, rotating);
  const inFlightMs = opts.inFlightMs ?? IN_FLIGHT_MS;
  const report: PurgeReport = { ...empty };

  // ---- cache-root walk: quarantine orphans --------------------------------
  const cacheEntries: Array<{ name: string; known: boolean }> = [];
  if (rootStatus.online) {
    try {
      const walk = await walkCacheRoot(root, known, now, inFlightMs);
      report.inFlight = walk.inFlight;
      cacheEntries.push(
        ...walk.kept.map(name => ({ name, known: true })),
        ...walk.orphans.map(name => ({ name, known: false })),
      );
    } catch {
      return { ...report, refused: true, reason: `cache root ${root} could not be read` };
    }
  }
  const plan = planOrphanPurge(cacheEntries, { confirm: opts.confirm });
  // Only the automatic pass stops at the ceiling. A dry run names it instead,
  // which is how the reason reaches the Stems page while the operator can still
  // confirm the move.
  const overCeiling = exceedsAutoCeiling(plan.quarantine.length, plan.keptCount);
  const ceilingReason = `would quarantine ${plan.quarantine.length} of ${plan.quarantine.length + plan.keptCount} stem dirs, `
    + 'more than an automatic pass moves on its own (is the library half-loaded?): '
    + 'confirm the move on the Stems page if it is right';
  const held = opts.automatic === true && opts.confirm && overCeiling;
  if (!opts.confirm && overCeiling) report.autoRefusal = ceilingReason;
  report.keptCount = plan.keptCount;
  report.quarantinedNames = held ? [] : plan.quarantine.map(q => q.name).slice(0, 10);

  // ---- quarantine walk -----------------------------------------------------
  // In parallel like the root walk: a dry run reads every entry on each Stems
  // page open, and a network share holds thousands of them.
  const rowDurationSec = opts.rowDurationSec ?? storedDurationSec;
  const quEntries: QuarantineEntry[] = await mapPool(await listDirs(qu), stemCache.SCAN_CONCURRENCY, async (name) => {
    const entryDir = path.join(qu, name);
    const liveSlotFree = !(await stat(path.join(root, name)).then(() => true, () => false));
    let ageMs = await quarantinedAgeMs(entryDir, now);
    if (ageMs == null) {
      // No readable stamp: its grace starts now. A confirmed pass stamps it so
      // the clock holds from here; if even that fails it stays at 0 and ages
      // never, which keeps it rather than deleting it early.
      if (opts.confirm) await stampQuarantine(entryDir, now).catch(() => {});
      ageMs = 0;
    }
    const isKnown = known.has(name);
    // Only a release asks whether the audio is the same, so only an entry that
    // could be released reads its evidence. An old id still rotating has no row
    // of its own: adoption moved it to the new id first, and that row is the
    // same file.
    const same = isKnown && liveSlotFree
      ? sameAudio(await stemsDurationSec(entryDir), rowDurationSec(rotating.get(name) ?? name))
      : false;
    return { name, known: isKnown, ageMs, liveSlotFree, sameAudio: same };
  });
  report.quarantineEntries = quEntries.length;
  const qplan = planQuarantinePurge(quEntries, { confirm: opts.confirm, ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}) });
  // The delete is the step nothing undoes, so it reads the dir again: an entry
  // that is not stems (an earlier build moved it) stays where it is.
  const deletable = await mapPool(qplan.deleted, stemCache.SCAN_CONCURRENCY, d => readsAsStems(path.join(qu, d.name)));
  const toDelete = qplan.deleted.filter((_, i) => deletable[i]);
  // Offline, only the aged delete runs: a release writes into a root that
  // cannot be vouched for, and the entry loses nothing by waiting.
  const toRelease = rootStatus.online ? qplan.released : [];
  report.deletedNames = held ? [] : toDelete.map(d => d.name).slice(0, 10);
  report.agingCount = qplan.aging.length;
  report.supersededCount = qplan.superseded.length;
  report.mismatchedCount = qplan.mismatched.length;

  if (opts.confirm) {
    // What the moves add to or take off the cache total, measured the way its
    // walk measures (the quarantine is outside that total, so a delete from
    // it changes nothing there). A move that cannot be measured leaves the
    // stored size to a walk.
    // Begun before the first move: a sweep or walk that lands during them
    // rewrites the totals from what it found, which may already hold some of
    // them (usageBase).
    const usage = await stemCache.UsageTally.begin();
    // 1. Releases first: an id that is both known now and sitting in the
    //    quarantine gets its copy back rather than being re-quarantined below.
    for (const name of toRelease) {
      try {
        await rename(path.join(qu, name), path.join(root, name));
      } catch { report.failed += 1; continue; }
      // Back in the cache it is not quarantined: a stale stamp must not ride
      // along into a later quarantine.
      await rm(path.join(root, name, ORPHANED_AT), { force: true }).catch(() => {});
      usage.count(+1, await stemCache.measuredDirBytes(path.join(root, name)));
      await stampReleasedStems(name);
      report.released.push(name);
    }
    // The ceiling reads as a half-loaded library, and on that reading a release
    // is safe while a delete is the one step nothing undoes, so a held pass
    // stops here and leaves the deletes and the moves to an operator's confirm.
    if (held) {
      report.refused = true;
      report.reason = ceilingReason;
    } else {
      // 2. Aged (and superseded-with-fresh-copy) quarantines: delete for good.
      for (const { name } of toDelete) {
        const { gone, freedBytes } = await deleteDir(path.join(qu, name));
        report.freedBytes += freedBytes;
        if (gone) report.deletedCount += 1;
        else report.failed += 1;
      }
      // 3. Orphans: move into quarantine (same-filesystem rename; no merge).
      await mkdirSafe(qu);
      const names = opts.resolveNames && plan.quarantine.length
        ? await opts.resolveNames(plan.quarantine.map(q => q.name))
        : undefined;
      for (const { name } of plan.quarantine) {
        const from = path.join(root, name);
        const to = path.join(qu, name);
        if (await stat(to).then(() => true, () => false)) {
          // This id is quarantined already: it came back, a fresh analysis took
          // the live slot, and it left again. The live copy is the newer one, so
          // it replaces the stale copy and starts a whole grace of its own. Never
          // the reverse: dropping the live copy would delete the only fresh stems
          // on the spot, and leave what remains to age out on the old stamp.
          // Deleting, so it reads the dir first, like the aged delete: an entry
          // that is not stems is left alone, and the live copy with it.
          if (!(await readsAsStems(to))) { report.failed += 1; continue; }
          const stale = await deleteDir(to);
          report.freedBytes += stale.freedBytes;
          if (!stale.gone) { report.failed += 1; continue; }
        }
        const leaving = await stemCache.measuredDirBytes(from);
        try {
          await rename(from, to);
        } catch { report.failed += 1; continue; }
        try {
          await stampQuarantine(to, now);
        } catch {
          // Unstamped, the quarantine would have no age to keep it 7 days: undo
          // the move and leave the dir in the cache for the next pass.
          const undone = await rename(to, from).then(() => true, () => false);
          // Stuck in the quarantine unstamped, it has left the cache total.
          if (!undone) usage.count(-1, leaving);
          report.failed += 1;
          continue;
        }
        usage.count(-1, leaving);
        await writeNameSidecar(to, names?.get(name), now);
        report.quarantined += 1;
      }
    }
    // The usage snapshot cached the pre-purge totals. The moves were measured,
    // so the totals move by exactly that and the next read needs no walk; only
    // a move that could not be measured marks them stale (stem-cache.ts,
    // usage snapshot). Deleting aged quarantines alone touches nothing.
    await usage.settle();
  } else {
    // Dry run: every count, zero mutations.
    report.quarantined = plan.quarantine.length;
    report.released = toRelease;
    report.deletedCount = toDelete.length;
  }
  return report;
}

// A released track's row is a new one with no stems_at, so a complete set would
// otherwise read as owed a separation. Best-effort: a stamp that cannot land
// costs a backfill run, nothing worse.
async function stampReleasedStems(id: string): Promise<void> {
  try {
    const expect = { fileSize: db.trackFileSize(id) };
    const complete = (await stemCache.hasWindow(id, 'head', expect)) && (await stemCache.hasWindow(id, 'tail', expect));
    if (complete) db.stampStemsCached(id);
  } catch { /* library closed */ }
}

// Throws when the stamp cannot be written: the move is then undone.
async function stampQuarantine(entryDir: string, now: number): Promise<void> {
  await writeFile(path.join(entryDir, ORPHANED_AT), String(now));
}

// Shared like the cache root (stem-cache.ts): mkdir's mode is masked by the
// umask, so 0o777 alone comes out 755. The chmod also opens up a quarantine an
// older controller left at 755; a refused chmod leaves the folder as it is.
async function mkdirSafe(dir: string): Promise<void> {
  const fs = await import('node:fs/promises');
  try { await fs.mkdir(dir, { recursive: true, mode: 0o777 }); } catch { /* reported by the move failures */ }
  try { await fs.chmod(dir, 0o777); } catch { /* not ours to change; the moves report failures */ }
}

/**
 * The nightly pass (scheduler.ts): confirmed, automatic (the share ceiling
 * applies), and stamping each quarantine's name like the manual confirm, so
 * the names outlive the event-log retention for the folders the cron moved
 * too.
 */
export async function runScheduledOrphanPurge(knownIds: readonly string[], now?: number): Promise<PurgeReport> {
  return runOrphanPurge({
    knownIds,
    confirm: true,
    automatic: true,
    resolveNames: ids => resolveOrphanNames(ids),
    ...(now !== undefined ? { now } : {}),
  });
}
