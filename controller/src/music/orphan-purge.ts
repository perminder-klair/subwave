// Orphan-stem purge, IO layer.
//
// planOrphanPurge / planQuarantinePurge (orphan-purge-pure.ts) decide; this
// file performs the moves on the share and reports. Rules the IO must keep:
//
// - NEVER delete an orphan directly. Orphans MOVE into <root>/.orphan-quarantine
//   (a dot-directory, so scanDirs and the marker walk ignore it), and only a
//   quarantine past the grace period is deleted. The quarantine is a move on
//   the same filesystem, so it is atomic and costs no copy — the property
//   root-squashed NFS shares need.
// - A quarantine whose id is in the library again is RELEASED back (the live
//   slot is free: a quarantine is a move, so exactly one copy exists). If a
//   fresh analysis already took the slot the quarantine is superseded and
//   simply ages out — never merged over the new copy.
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
// - An empty id set is REFUSED, not treated as an empty library. The only
//   cheap way to get zero ids is a closed or half-open database, and quarantining
//   a whole cache on that reading is exactly the mass deletion quarantine exists
//   to survive.
// - Delete failures are counted and reported, never thrown — a purge that
//   cannot delete on a squashed share must keep running and keep saying so.
// - Any mutation drops the usage snapshot (stem-cache's cached walk totals),
//   so the next sweep re-measures instead of trusting stale bytes.
// - One confirmed pass at a time (the cron, a manual confirm): a second one
//   is refused while the first runs, so two never interleave their moves and
//   each report is what its own pass did. A release that lands on a live slot
//   an analyzer mkdir just created replaces that empty dir (rename onto an
//   empty dir), and onto a non-empty one fails and is counted.
// - The automatic pass (runScheduledOrphanPurge) refuses a plan above
//   AUTO_MAX_SHARE of the cache and leaves it to an operator's confirm, and
//   stamps each quarantine's name like the manual one.

import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { mapPool } from '../util/async-pool.js';
import * as stemCache from './stem-cache.js';
import { resolveOrphanNames, writeNameSidecar, type OrphanTrackName } from './orphan-names.js';
import {
  exceedsAutoCeiling,
  IN_FLIGHT_MS,
  planOrphanPurge,
  planQuarantinePurge,
  QUARANTINE_DIR,
  type QuarantineEntry,
} from './orphan-purge-pure.js';

export { IN_FLIGHT_MS };

// Set while a confirmed pass runs; a second confirmed pass is refused.
let confirmedPassRunning = false;

/** Sidecar stamped into a quarantine entry at move time. */
const ORPHANED_AT = '.orphaned-at';

export interface PurgeReport {
  dryRun: boolean;
  /** Cache dirs whose track is still in the library. */
  keptCount: number;
  /** Orphans moved into the quarantine (dry run: would move). */
  quarantined: number;
  quarantinedNames: string[];
  /** Quarantine entries moved back to the live cache. */
  released: string[];
  /** Quarantine entries deleted (dry run: would delete). */
  deletedCount: number;
  deletedNames: string[];
  /** Quarantine entries inside the grace period. */
  agingCount: number;
  /** Quarantines whose id is back in the library while the live slot is taken. */
  supersededCount: number;
  /** Cache dirs skipped as in-flight (written within IN_FLIGHT_MS). */
  inFlight: number;
  /** Moves/deletes that failed this pass (permissions, squashed roots). */
  failed: number;
  /** True when the pass refused to run; `reason` says why. */
  refused?: boolean;
  reason?: string;
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

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return []; // no quarantine yet
  }
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

function emptyReport(dryRun: boolean): PurgeReport {
  return {
    dryRun, keptCount: 0, quarantined: 0, quarantinedNames: [], released: [],
    deletedCount: 0, deletedNames: [], agingCount: 0, supersededCount: 0, inFlight: 0, failed: 0,
    freedBytes: 0,
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
    // delete runs — quarantining NEW dirs into a share we cannot vouch for is
    // the step that stays refused.
    if (!quExists) return { ...empty, refused: true, reason: 'offline', offline: rootStatus.message };
  }

  if (opts.knownIds.length === 0) {
    return { ...empty, refused: true, reason: 'empty library id set: refusing (a closed or half-loaded database must never quarantine the cache)' };
  }
  const known = new Set(opts.knownIds);
  const inFlightMs = opts.inFlightMs ?? IN_FLIGHT_MS;
  const report: PurgeReport = { ...empty };

  // ---- cache-root walk: quarantine orphans --------------------------------
  let entries: string[] = [];
  if (rootStatus.online) {
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name);
    } catch {
      return { ...report, refused: true, reason: `cache root ${root} could not be read` };
    }
  }
  // Only an orphan needs its mtime (the in-flight check): a known id is kept
  // whatever its age, so the walk stats just the orphans, in parallel, which
  // keeps a 76k-dir share from costing one round trip per track.
  const cacheEntries: Array<{ name: string; known: boolean }> = [];
  const orphanNames: string[] = [];
  for (const name of entries) {
    if (known.has(name)) cacheEntries.push({ name, known: true });
    else orphanNames.push(name);
  }
  const ages = await mapPool(orphanNames, stemCache.SCAN_CONCURRENCY,
    name => stat(path.join(root, name)).then(st => st.mtimeMs, () => null));
  orphanNames.forEach((name, i) => {
    const mtimeMs = ages[i];
    if (mtimeMs == null) return; // vanished mid-walk
    if (now - mtimeMs < inFlightMs) { report.inFlight += 1; return; }
    cacheEntries.push({ name, known: false });
  });
  const plan = planOrphanPurge(cacheEntries, { now, confirm: opts.confirm });
  if (opts.automatic && opts.confirm && exceedsAutoCeiling(plan.quarantine.length, plan.keptCount)) {
    return {
      ...report, keptCount: plan.keptCount, quarantined: 0, refused: true,
      reason: `would quarantine ${plan.quarantine.length} of ${plan.quarantine.length + plan.keptCount} stem dirs, `
        + 'more than an automatic pass moves on its own (is the library half-loaded?): '
        + 'check the Stems page and confirm the move there if it is right',
    };
  }
  report.keptCount = plan.keptCount;
  report.quarantinedNames = plan.quarantine.map(q => q.name).slice(0, 10);

  // ---- quarantine walk -----------------------------------------------------
  const quEntries: QuarantineEntry[] = [];
  const quNames = await listDirs(qu);
  for (const name of quNames) {
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
    quEntries.push({ name, known: known.has(name), ageMs, liveSlotFree });
  }
  const qplan = planQuarantinePurge(quEntries, { now, confirm: opts.confirm, ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}) });
  report.released = qplan.released;
  report.deletedNames = qplan.deleted.map(d => d.name).slice(0, 10);
  report.agingCount = qplan.aging.length;
  report.supersededCount = qplan.superseded.length;

  if (opts.confirm) {
    // 1. Releases first: an id that is both known now and sitting in the
    //    quarantine gets its copy back rather than being re-quarantined below.
    for (const name of qplan.released) {
      try {
        await rename(path.join(qu, name), path.join(root, name));
      } catch { report.failed += 1; continue; }
      // Back in the cache it is not quarantined: a stale stamp must not ride
      // along into a later quarantine.
      await rm(path.join(root, name, ORPHANED_AT), { force: true }).catch(() => {});
    }
    // 2. Aged (and superseded-with-fresh-copy) quarantines: delete for good.
    for (const { name } of qplan.deleted) {
      const entryDir = path.join(qu, name);
      const before = await dirBytes(entryDir);
      let removed = true;
      try {
        await rm(entryDir, { recursive: true, force: true });
      } catch { removed = false; }
      // Freed is what is really gone: a delete refused part-way (a squashed
      // share) leaves files behind, and those are not reclaimed space.
      const gone = await stat(entryDir).then(() => false, () => true);
      if (removed && gone) {
        report.freedBytes += before;
        report.deletedCount += 1;
      } else {
        if (!gone) report.freedBytes += Math.max(0, before - await dirBytes(entryDir));
        report.failed += 1;
      }
    }
    // 3. Orphans: move into quarantine (same-filesystem rename; no merge).
    await mkdirSafe(qu);
    const names = opts.resolveNames && plan.quarantine.length
      ? await opts.resolveNames(plan.quarantine.map(q => q.name))
      : undefined;
    for (const { name } of plan.quarantine) {
      const from = path.join(root, name);
      const to = path.join(qu, name);
      const collision = await stat(to).then(() => true, () => false);
      if (collision) {
        // A quarantine entry for the same id already exists — it can only have
        // been re-created in the library and orphaned again. Keep the existing
        // quarantine with its own stamp and drop the live copy. (This used to
        // compare ages, but the live dir's only age was its mtime, which a
        // rename keeps and the header rules out.)
        try {
          await rm(from, { recursive: true, force: true });
          await writeNameSidecar(to, names?.get(name), now);
          report.quarantined += 1;
        } catch { report.failed += 1; }
        continue;
      }
      try {
        await rename(from, to);
      } catch { report.failed += 1; continue; }
      try {
        await stampQuarantine(to, now);
      } catch {
        // Unstamped, the quarantine would have no age to keep it 7 days: undo
        // the move and leave the dir in the cache for the next pass.
        await rename(to, from).catch(() => {});
        report.failed += 1;
        continue;
      }
      await writeNameSidecar(to, names?.get(name), now);
      report.quarantined += 1;
    }
    if (report.quarantined || report.deletedCount || report.released.length) {
      // The usage snapshot cached the pre-purge totals; drop it so the next
      // sweep walks again instead of trusting bytes that no longer exist.
      await rm(path.join(config.stateDir, 'stem-cache-usage.json'), { force: true }).catch(() => {});
    }
  } else {
    // Dry run: every count, zero mutations.
    report.quarantined = plan.quarantine.length;
    report.deletedCount = qplan.deleted.length;
  }
  return report;
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

/** Dry-run convenience for the doctor and the admin route. */
export async function orphanPurgeReport(knownIds: readonly string[]): Promise<PurgeReport> {
  return runOrphanPurge({ knownIds, confirm: false });
}
