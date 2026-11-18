// The guard both start-of-run sweeps apply before removing an entry they
// matched by name in a shared tmpdir(): the test runner's (stale-state-dirs.ts)
// and the bench tools' (isolated-state.ts). A name proves nothing in /tmp,
// where anyone can create a file, a symlink or a dir called anything. Each
// sweep only ever makes directories, so only a real directory (lstat, never
// followed through a symlink) that this user owns is ever its to remove. One
// another user owns is never ours, and as root a recursive remove of it would
// walk a tree that user controls.
import { lstatSync, type Stats } from 'node:fs';

// The entry's lstat when it passes, else undefined. Throws as lstatSync does,
// for the caller's catch: the entry is gone already. `uid` is undefined where
// the platform has none (Windows), and then ownership is not checked.
export function ownedDirStat(path: string, uid: number | undefined): Stats | undefined {
  const stat = lstatSync(path);
  return stat.isDirectory() && (uid === undefined || stat.uid === uid) ? stat : undefined;
}
