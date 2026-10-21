// Write a uniquely named temp beside the target, then rename to prevent partial reads.
// Adjacent temps keep rename on one filesystem; unique suffixes isolate concurrent writers.
// Remove failed temps without masking the original error.
//
// A replace keeps the target's own mode and owner: rename swaps in a new inode,
// which would otherwise land at 0666 & ~umask and undo an operator's chmod on
// every save. `mode` is the mode a NEW file gets and, on a replace, a ceiling —
// the stored mode is intersected with it — so a secret-bearing file passes
// 0o600 and is tightened on its next write even where an older build left it
// wider. The temp is opened exclusively ('wx'), so a path already sitting at
// the temp's name — a link included — is refused rather than followed.

import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
  closeSync, fchmodSync, fchownSync, fsyncSync, linkSync, lstatSync, openSync, renameSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';

export interface AtomicWriteOptions {
  // Mode for a new file; on a replace, the most the stored mode may keep.
  mode?: number;
}

interface TempPlan {
  createMode: number;            // mode the temp is opened with (umask applies)
  finalMode: number | undefined; // exact mode applied before publishing, if any
  owner: { uid: number; gid: number } | null;
}

// Only a regular file's mode/owner is worth keeping: a link's lstat mode is
// 0777, and following it would copy some other file's.
function planFrom(st: Stats | null, mode: number | undefined): TempPlan {
  if (st && st.isFile()) {
    const kept = st.mode & 0o7777;
    const finalMode = mode != null ? kept & mode : kept;
    // Opened owner-only, so the temp is never wider than its final mode while
    // it is being filled; the exact mode is applied before the rename.
    return { createMode: 0o600 & finalMode, finalMode, owner: { uid: st.uid, gid: st.gid } };
  }
  return { createMode: mode ?? 0o666, finalMode: undefined, owner: null };
}

// Best-effort: only root can hand a file to another owner, and a replace that
// cannot keep its owner should still land rather than fail the save.
function sameOwner(owner: TempPlan['owner']): boolean {
  if (!owner) return true;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === owner.uid && gid === owner.gid;
}

export async function writeFileAtomic(
  path: string,
  contents: string | Buffer,
  { mode }: AtomicWriteOptions = {},
): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  const plan = planFrom(await lstat(path).catch(() => null), mode);
  // Set once the exclusive open succeeds: a path that was already at the temp's
  // name is not this writer's to remove.
  let created = false;
  try {
    const fh = await open(tmp, 'wx', plan.createMode);
    created = true;
    try {
      await fh.writeFile(contents);
      if (!sameOwner(plan.owner)) await fh.chown(plan.owner!.uid, plan.owner!.gid).catch(() => {});
      if (plan.finalMode != null) await fh.chmod(plan.finalMode);
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    if (created) await unlink(tmp).catch(() => {});
    throw err;
  }
}

// One instance per owning store, shared by ordinary saves and durable recovery
// writes. Atomic rename prevents partial files, but only ordering prevents an
// older snapshot from replacing a newer one after recovery is acknowledged.
export function createSerialFileWriter(path: string) {
  let pending: Promise<void> = Promise.resolve();
  return (contents: string | Buffer): Promise<void> => {
    const next = pending.then(() => writeFileAtomic(path, contents));
    // Keep this caller's rejection while allowing subsequent saves to retry.
    pending = next.catch(() => {});
    return next;
  };
}

// Synchronous twin for small state whose publication is itself a synchronous
// commit boundary. It keeps the same adjacent-temp + rename contract, so a
// reader can never observe a partial replacement.
export function writeFileAtomicSync(
  path: string,
  contents: string | Buffer,
  { mode, durable = false, replace = true }: AtomicWriteOptions & { durable?: boolean; replace?: boolean } = {},
): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  let st: Stats | null = null;
  try { st = lstatSync(path); } catch {}
  const plan = planFrom(st, mode);
  let created = false;
  try {
    const fd = openSync(tmp, 'wx', plan.createMode);
    created = true;
    try {
      writeFileSync(fd, contents);
      if (!sameOwner(plan.owner)) {
        try { fchownSync(fd, plan.owner!.uid, plan.owner!.gid); } catch {}
      }
      if (plan.finalMode != null) fchmodSync(fd, plan.finalMode);
      if (durable) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) renameSync(tmp, path);
    else {
      // Claim an immutable recovery snapshot without replacing another boot's
      // journal. link(2) publishes atomically and refuses an existing target.
      linkSync(tmp, path);
      unlinkSync(tmp);
    }
    if (durable) {
      const fd = openSync(dirname(path), 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  } catch (err) {
    if (created) {
      try { unlinkSync(tmp); } catch {}
    }
    throw err;
  }
}
