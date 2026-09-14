// Atomic file replacement: write a temp beside the target, then rename(2) over
// it, so Liquidsoap's polls and the durable JSON writers never see a truncated
// file. The temp carries a random suffix (two un-serialised writers must not
// rename each other's temp into place) and sits next to the target so the
// rename never crosses a filesystem.
//
// A failed write removes its temp — nothing else can ever find that name, and
// for the scheduled backup it would be a partial multi-hundred-MB zip. The
// ORIGINAL error still propagates; cleanup must not mask it.

import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
  { mode }: { mode?: number } = {},
): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, contents, mode != null ? { mode } : {});
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}
