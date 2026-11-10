// One directory listing for GET /debug/state-tree. NEVER recursive: state/stems
// holds tens of thousands of dirs and state/archive grows forever. The cap is
// applied AFTER sorting and BEFORE stat, so a 200k-entry dir costs one readdir
// and MAX_ENTRIES stats; `total` still reports the real size.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ENTRIES, realStatePath, resolveStatePath } from './state-path.js';

export type StateEntry = {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size?: number;
  mtime?: string;
};

export type StateListing = {
  root: string;
  path: string;
  entries: StateEntry[];
  shown: number;
  total: number;
};

/** Thrown for a malformed path — the route answers 400. A path that is merely
 *  missing or unreadable comes back as `{ error }` instead (see listStateDir). */
export class BadStatePathError extends Error {}

/** Directories first, then by name. Fixed locale so LANG can't reorder it. */
function compareEntries(a: StateEntry, b: StateEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, 'en');
}

export async function listStateDir(root: string, rel: string): Promise<StateListing> {
  const abs = resolveStatePath(root, rel);
  if (!abs) throw new BadStatePathError('path escapes the state dir');
  const real = await realStatePath(root, abs);
  if (!real) throw new BadStatePathError('path escapes the state dir');

  // withFileTypes classifies every entry off the dirent, costing no stat.
  const dirents = await readdir(real, { withFileTypes: true });
  const all: StateEntry[] = dirents.map((d) => ({
    name: d.name,
    // A symlink to a directory is false here; the following stat corrects it.
    isDir: d.isDirectory(),
    isSymlink: d.isSymbolicLink(),
  }));
  all.sort(compareEntries);

  const entries = all.slice(0, MAX_ENTRIES);
  await Promise.all(entries.map(async (e) => {
    try {
      const s = await stat(join(real, e.name));
      e.size = s.size;
      e.mtime = s.mtime.toISOString();
      if (s.isDirectory()) e.isDir = true;
    } catch {
      // A broken symlink costs this entry its size/mtime, never the listing.
    }
  }));
  // stat can promote a symlink to a directory, so re-sort to keep dirs first.
  entries.sort(compareEntries);

  return {
    root,
    path: rel.replace(/^\/+/, '').replace(/\/+$/, ''),
    entries,
    shown: entries.length,
    total: all.length,
  };
}
