// Cross-restart lock for the background tagger + analyzer runs. The tagger child
// is detached, so a controller restart orphans a live worker while in-memory state
// resets to idle; the pidfile on the shared state dir is the only handle that
// survives, and so is the source of truth for both the controller spawn path and
// the standalone CLIs. Two writers on the library DB is the failure it prevents.
// Imports config only, so the CLI entry points don't pull in the broadcast layer.

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { config } from '../config.js';

export interface PidfileInfo {
  pid: number;
  mode: string;
  startedAt: string;
  args: string[];
}

// Set on a controller-spawned child's env (broadcast/tagger.ts): the controller
// already holds the pidfile, so the CLI must not re-check or clear it. Without it
// the child reads the pidfile naming its own still-live npx ancestor and calls
// that a conflicting run.
export const MANAGED_ENV = 'SUBWAVE_TAGGER_MANAGED';

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

// Liveness on the POSITIVE pid (signal 0 tests existence only). Callers that KILL
// a detached run pass the negative pid for the group, but a group has no liveness
// of its own. EPERM means alive but not ours to signal.
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

// Lock for a standalone CLI run. Returns whether this process owns the pidfile
// and must clear it on exit: false when controller-spawned (the controller owns
// and clears it), throws when a different live run holds it, otherwise claims it
// (a stale dead pid is reclaimed silently).
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

// Graceful paths only; a SIGKILLed run leaves the file behind and the next run
// reclaims it as stale.
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
