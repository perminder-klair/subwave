// Atomic file replacement — write to a temp file beside the target, then
// rename(2) over it, so no reader ever observes a half-written file.
//
// Two reader populations make this matter:
//   - Liquidsoap consumes several state files the controller writes (auto.m3u
//     via reload_mode="watch", the next/say/intro/sfx handoffs via a
//     read-delete poll) — a poll or inotify event landing mid-write would see
//     a truncated file.
//   - Durable JSON (settings.json, session.json, queue.json, …) survives a
//     crash or power loss mid-write only if the old contents stay intact
//     until the new ones are fully on disk.
//
// The temp name carries a random suffix so two un-serialised writers to the
// same path can't rename each other's half-written temp into place. The temp
// lives next to the target, so the rename never crosses a filesystem boundary.

// A FAILED write must not leave its temp behind. The random suffix that makes
// concurrent writers safe also means nothing can ever find the file again: no
// later call reuses the name, and a `.tmp` is invisible to every consumer that
// scans the state dir by extension. For the small JSON writers that is a stray
// few hundred bytes; for the scheduled backup (backup/scheduled.ts) it is a
// partial multi-hundred-MB zip, dropped by exactly the failures that leave the
// disk least able to afford it — ENOSPC, or the controller being restarted
// mid-write. So the temp is removed on the way out of both failing steps, and
// the ORIGINAL error is what propagates: the cleanup is bookkeeping, and a
// failure to unlink must not mask why the write failed.

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
    // Swallowed: a writeFile that failed before creating the file leaves
    // nothing to remove, and that is not a second failure worth reporting.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
