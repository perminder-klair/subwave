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

import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';

export async function writeFileAtomic(
  path: string,
  contents: string | Buffer,
  { mode }: { mode?: number } = {},
): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, contents, mode != null ? { mode } : {});
  await rename(tmp, path);
}
