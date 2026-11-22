// Workaround for Bun's macOS stdin bug (oven-sh/bun#13374): under a parent whose
// stdin is piped, process.stdin delivers no bytes even though isTTY is true, so
// a Clack prompt hangs unkillably. Open /dev/tty as a fresh ReadStream and pass
// it to Clack as the prompt's `input` (forwarded by cli/scripts/patch-clack.mjs).
//
// macOS only. Bun's tty.ReadStream is built on fs.ReadStream with `start: 0`, so
// it reads with pread at an explicit offset. macOS allows that on a tty; Linux
// rejects it with ESPIPE ("invalid seek, read"), crashing every prompt (#2262).
// Linux doesn't have #13374, so it stays on process.stdin, as it did up to
// v1.29.0. Returns undefined off macOS or with no /dev/tty (CI, headless),
// leaving Clack on its default.

import { openSync } from 'node:fs';
import { ReadStream } from 'node:tty';

let cached: NodeJS.ReadStream | null | undefined;

export function getInteractiveInput(): NodeJS.ReadStream | undefined {
  if (cached !== undefined) return cached ?? undefined;

  if (process.platform !== 'darwin') {
    cached = null;
    return undefined;
  }

  try {
    const fd = openSync('/dev/tty', 'r');
    cached = new ReadStream(fd);
    return cached;
  } catch {
    cached = null;
    return undefined;
  }
}

// True in the piped-parent configuration that triggers #13374, where even the
// fresh /dev/tty stream may never deliver bytes. Read only by ui.ts's watchdog.
export function inPipedStdinDangerZone(): boolean {
  return !process.stdin.isTTY;
}
