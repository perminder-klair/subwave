// Workaround for Bun's macOS stdin bug (oven-sh/bun#13374).
//
// When the standalone binary is launched from a parent process whose stdin
// is piped (rather than a TTY) — `curl … | sh → exec subwave init </dev/tty`
// hits this exactly — Bun's `process.stdin` doesn't deliver bytes on macOS.
// The TTY ReadStream is created correctly (isTTY=true, setRawMode is a real
// function, ctor=ReadStream — confirmed via SUBWAVE_TTY_DEBUG=1 diagnostic),
// `setRawMode` succeeds, but reads never produce data. Result: Clack's
// prompt renders and then hangs forever — no typing, no Ctrl-C, no kill.
//
// We can't fix Bun's stdin layer from user code. What we CAN do is sidestep
// it: open `/dev/tty` ourselves as a fresh `tty.ReadStream` and hand THAT
// to Clack as the prompt's `input`. @clack/core supports an `input` option
// on every prompt; @clack/prompts' high-level wrappers don't forward it by
// default, so cli/scripts/patch-clack.mjs runs at build time to thread it
// through. Our wrapper in cli/src/ui.ts then injects this stream into every
// `p.text` / `p.password` / `p.confirm` / `p.select` call.
//
// Safe no-op when /dev/tty isn't available (CI, headless containers): we
// return undefined and the wrapper passes through to Clack's normal
// `process.stdin` default. Commands that don't prompt (--version, help,
// status) work unchanged regardless.

import { openSync } from 'node:fs';
import { ReadStream } from 'node:tty';

let cached: NodeJS.ReadStream | null | undefined;

export function getInteractiveInput(): NodeJS.ReadStream | undefined {
  if (cached !== undefined) return cached ?? undefined;

  try {
    const fd = openSync('/dev/tty', 'r');
    cached = new ReadStream(fd);
    return cached;
  } catch {
    cached = null;
    return undefined;
  }
}

// True when we're in the configuration that triggers oven-sh/bun#13374: the
// process was launched from a piped parent (process.stdin isn't a TTY), so even
// the freshly-opened /dev/tty stream may never deliver bytes and an interactive
// prompt would hang un-killably. Direct interactive runs have isTTY === true and
// are never in danger. ui.ts uses this to arm a watchdog (it's a no-op signal on
// its own — see armHangWatchdog there).
export function inPipedStdinDangerZone(): boolean {
  return !process.stdin.isTTY;
}
