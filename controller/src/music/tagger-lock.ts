// Cross-restart / cross-process lock for the background tagger + analyzer runs.
//
// The tagger child is spawned detached (its own process group), so a controller
// restart mid-run ORPHANS a live worker while the in-memory `tagger` state
// resets to idle — a second Start would then put two writers on the same SQLite
// library DB and double the LLM spend. A pidfile on the shared state dir is the
// only handle that survives a restart, so it's the source of truth for "is a run
// already in flight?" across both the controller spawn path and the standalone
// CLIs (`npm run tag` / `npm run analyze`).
//
// Dependency-light on purpose (config only) so both the server and the CLI
// entry points can import it without dragging in the broadcast layer.

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { config } from '../config.js';

export interface PidfileInfo {
  pid: number;
  mode: string;
  startedAt: string;
  args: string[];
}

// Set on a controller-spawned child's env (see broadcast/tagger.ts). Tells a CLI
// it was launched BY the controller, which already holds the pidfile + the
// in-memory single-flight — so the CLI must not re-check or clear it. Without
// this the child would read the pidfile the controller just wrote (naming the
// still-live npx wrapper, the child's own ancestor) and mistake it for a
// conflicting run.
export const MANAGED_ENV = 'SUBWAVE_TAGGER_MANAGED';

// One canonical location, derived from the same state dir everywhere (container
// /var/sub-wave via STATE_DIR, or the repo-local state/ on a host checkout).
export function pidfilePath(): string {
  return `${config.stateDir}/tagger.pid`;
}

export function readPidfile(): PidfileInfo | null {
  try {
    const j = JSON.parse(readFileSync(pidfilePath(), 'utf8'));
    return typeof j?.pid === 'number' ? (j as PidfileInfo) : null;
  } catch {
    return null; // absent or malformed → treat as no lock
  }
}

export function writePidfile(info: PidfileInfo): void {
  writeFileSync(pidfilePath(), JSON.stringify(info));
}

export function clearPidfile(): void {
  try {
    rmSync(pidfilePath());
  } catch {
    /* already gone */
  }
}

// Liveness probe on the POSITIVE pid — signal 0 delivers nothing, it just tests
// existence/permission. Callers that KILL a detached run use the negative pid to
// hit the whole process group, but liveness is always tested on the leader
// itself (a group has no "aliveness" of its own). EPERM means the process exists
// but isn't ours to signal — still alive.
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

// Acquire the lock for a STANDALONE CLI run (npm run tag / analyze). Returns
// whether this process now owns the pidfile and must clear it on exit:
//   - controller-spawned (MANAGED_ENV set): returns false, never touches the
//     file — the controller owns it and clears it on the child's exit.
//   - a *different* live run already holds it: throws, so a manual run can't
//     become a second writer alongside a controller run (or another manual one).
//   - stale (dead pid) or absent: silently (re)claims it for this process.
export function acquireStandaloneLock(mode: string, args: string[]): boolean {
  if (process.env[MANAGED_ENV] === '1') return false;
  const existing = readPidfile();
  if (existing && isPidAlive(existing.pid)) {
    throw new Error(
      `another tagger run is already active (pid ${existing.pid}, mode ${existing.mode}, ` +
        `since ${existing.startedAt}) — refusing to start a second writer on the library DB`,
    );
  }
  writePidfile({ pid: process.pid, mode, startedAt: new Date().toISOString(), args });
  return true;
}

// Register best-effort pidfile cleanup for a standalone run. SIGKILL can't be
// trapped (the file is left behind, but isPidAlive() detects it as stale on the
// next run and replaces it), so this only needs to cover the graceful paths.
export function installPidfileCleanup(): void {
  process.on('exit', clearPidfile);
  process.on('SIGTERM', () => {
    clearPidfile();
    process.exit(143);
  });
  process.on('SIGINT', () => {
    clearPidfile();
    process.exit(130);
  });
}
