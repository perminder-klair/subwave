// Use realpath containment for /debug/state-tree to block symlink escapes.
// A bind mount under state/stems still resolves inside the state root.

import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** Entries per directory listing; callers are also told the real `total`. */
export const MAX_ENTRIES = 500;

/** Resolve a relative path against the state dir, or null if it escapes. `null`
 * means the REQUEST was malformed (400), not that the path is missing. */
export function resolveStatePath(root: string, rel: string): string | null {
  if (typeof rel !== 'string') return null;
  // Empty / '.' / '/' all mean the root itself.
  const raw = rel.replace(/^\/+/, '').trim();
  if (raw === '' || raw === '.') return resolve(root);
  // Absolute paths (Windows 'C:\', UNC) survive the leading-slash strip above.
  if (isAbsolute(raw)) return null;
  if (raw.includes('\0')) return null;

  // Normalise FIRST, then refuse what is left: 'a/../b' is legitimate.
  const norm = normalize(raw);
  if (norm === '..' || norm.startsWith(`..${sep}`) || norm.includes(`${sep}..${sep}`)) return null;

  const abs = resolve(join(root, norm));
  return containedIn(resolve(root), abs) ? abs : null;
}

/** Lexical containment: `abs` is root itself or sits underneath it. */
export function containedIn(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The realpath half of the guard: resolves symlinks and re-checks containment.
 * Split out so the lexical rule stays pure and synchronous.
 *
 * A path that does not exist cannot be realpath'd, so its deepest EXISTING
 * ancestor is resolved instead and the missing tail appended. Both sides of the
 * comparison must be resolved: `abs` is built from the unresolved root, so on a
 * symlinked state dir (macOS's /var -> /private/var, a symlinked checkout) a
 * lexical fallback reads every missing path as an escape. Any other realpath
 * failure, and an ancestor that exists but will not resolve (a dangling
 * symlink), fails closed.
 */
export async function realStatePath(root: string, abs: string): Promise<string | null> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  let real: string | null;
  try {
    real = await realpath(abs);
  } catch (err) {
    if (!isMissing(err)) return null;
    real = await realMissingPath(abs);
  }
  return real && containedIn(realRoot, real) ? real : null;
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Resolve the deepest existing ancestor of a missing path and append the
 *  rest, or null when that cannot be done safely. */
async function realMissingPath(abs: string): Promise<string | null> {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return null;
    tail.unshift(basename(cur));
    cur = parent;
    let realParent: string;
    try {
      realParent = await realpath(cur);
    } catch (err) {
      if (isMissing(err)) continue;
      return null;
    }
    // The first missing component must be truly absent. If lstat finds it,
    // it is a link realpath could not follow, and its target is unknown.
    const first = join(realParent, tail[0]);
    const present = await lstat(first).then(() => true, (e) => !isMissing(e));
    return present ? null : join(realParent, ...tail);
  }
}
