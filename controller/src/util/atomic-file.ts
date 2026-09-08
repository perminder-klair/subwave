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
