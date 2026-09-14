// The one place that answers "does this operator-supplied path point inside the
// state dir?" (GET /debug/state-tree). Never inline a second copy: a wrong
// answer here is a filesystem read primitive over the whole host.
//
// The realpath containment check stops a symlink planted in the state dir from
// exposing /etc or the music library, and stays compatible with the documented
// bind mount at <state>/stems (a bind mount realpaths INSIDE root).

import { realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

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
 * Split out so the lexical rule stays pure and synchronous. A path that does not
 * exist cannot be realpath'd, so it falls back to the lexical answer.
 */
export async function realStatePath(root: string, abs: string): Promise<string | null> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  try {
    const real = await realpath(abs);
    return containedIn(realRoot, real) ? real : null;
  } catch {
    // ENOENT (and friends): nothing to follow, so nothing can escape.
    return containedIn(realRoot, abs) ? abs : null;
  }
}
