// Re-attach stdin to /dev/tty when it isn't already a TTY.
//
// Background — the `curl … | sh` install path leaves the installer's stdin
// attached to the curl pipe (not the operator's terminal). install.sh works
// around that by `exec subwave init </dev/tty`, which redirects fd 0 to the
// controlling terminal. For Node-built CLIs that's enough — the binary sees
// `process.stdin.isTTY === true` and Clack's `setRawMode()` enables keypress
// handling.
//
// For the **Bun-compiled standalone binary** the redirect doesn't always
// propagate `isTTY=true` on macOS and inside some sudo/SSH layouts on Linux.
// Clack gates `setRawMode` on `input.isTTY`, so without it:
//
//   - keystrokes are line-buffered (the prompt looks frozen)
//   - Ctrl-C never reaches the keypress handler (the process can't be killed)
//   - backspace/arrows do nothing visible (no way to go back)
//
// All three symptoms hit the first prompt — `subwave init`'s "Install
// directory" — because that's the first call to `setRawMode`.
//
// Fix: open /dev/tty ourselves with `fs.openSync` and wrap it in a
// `tty.ReadStream`, then replace `process.stdin`. The resulting stream
// reports `isTTY === true` regardless of how the parent shell handed us
// fd 0, so Clack's raw-mode path is restored. Safe no-op when stdin is
// already a TTY; fails closed (skips replacement, no crash) when /dev/tty
// isn't available (CI, headless containers).

import { openSync, closeSync } from 'node:fs';
import { ReadStream } from 'node:tty';

export function ensureTTYStdin(): void {
  if (process.stdin.isTTY) return;

  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch {
    // No controlling terminal — likely CI or a piped non-interactive call.
    // Commands that don't need prompts (--version, --help, status, etc.)
    // still work; interactive prompts will fail with Clack's own error
    // rather than appearing to hang.
    return;
  }

  try {
    const tty = new ReadStream(fd);
    Object.defineProperty(process, 'stdin', {
      value: tty,
      configurable: true,
      writable: false,
    });
  } catch {
    // ReadStream construction failed — let prompts fail naturally on the
    // original stdin instead of crashing here.
    try { closeSync(fd); } catch { /* ignore */ }
  }
}
