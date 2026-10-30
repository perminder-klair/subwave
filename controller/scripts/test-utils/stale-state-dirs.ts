// Start-of-run sweep for the STATE_DIRs a killed run left behind.
//
// The run's dir and every file's dir (test-utils/state-dir.ts) are removed on
// a normal exit, but Ctrl+C or a SIGTERM kills each process before its 'exit'
// cleanup runs — one dir per file still running under --jobs. Handling signals
// in the children would sit on top of node:test's own, so scripts/run-tests.ts
// sweeps here at the start of the next run instead.
//
// Deliberately narrow: only the top level of the given dir, only a directory
// (never followed through a symlink) whose WHOLE name is the prefix plus
// mkdtemp's six-character suffix, and only one untouched for a day. That keeps
// clear of a run still going in another checkout unless the run itself is a
// day old: nothing writes to a run's own dir once it is made, so its age is
// the run's age. It must also be owned by this user (owned-dir.ts): the
// default tmpdir() is a shared /tmp, where anyone can create a dir by that
// name and backdate it, and one another user owns is never ours.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ownedDirStat } from './owned-dir.js';

export const STATE_DIR_PREFIX = 'subwave-test-state-';
const STATE_DIR_NAME = new RegExp(`^${STATE_DIR_PREFIX}[A-Za-z0-9]{6}$`);
const STALE_MS = 24 * 60 * 60 * 1000;

// `uid` is undefined where the platform has none (Windows), and then ownership
// is not checked.
export function sweepStaleStateDirs(root: string, now = Date.now(), uid = process.getuid?.()): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!STATE_DIR_NAME.test(name)) continue;
    const path = join(root, name);
    try {
      const stat = ownedDirStat(path, uid);
      if (!stat || now - stat.mtimeMs < STALE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Gone already (another run swept it), or not ours to remove.
    }
  }
  return removed;
}
