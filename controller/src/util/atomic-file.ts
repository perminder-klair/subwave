// Write a uniquely named temp beside the target, then rename to prevent partial reads.
// Adjacent temps keep rename on one filesystem; unique suffixes isolate concurrent writers.
// Remove failed temps without masking the original error.

import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { closeSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';

export async function writeFileAtomic(
  path: string,
  contents: string | Buffer,
  { mode }: { mode?: number } = {},
): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, contents, mode != null ? { mode } : {});
    await rename(tmp, path);
  } catch (err) {
    // Nothing to remove if writeFile failed before creating the file.
    await unlink(tmp).catch(() => {});
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
  { mode, durable = false, replace = true }: { mode?: number; durable?: boolean; replace?: boolean } = {},
): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, contents, mode != null ? { mode } : {});
    if (durable) {
      const fd = openSync(tmp, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
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
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}
