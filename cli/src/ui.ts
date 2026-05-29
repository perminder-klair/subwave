// Shared UI helpers for the SUB/WAVE operator CLI.
//
// Wraps @clack/prompts + picocolors so commands share a consistent voice and
// can opt into "menu mode" — where Esc inside a prompt throws MENU_BACK
// instead of cancelling the whole process. The main menu loop catches
// MENU_BACK and re-renders, giving the operator a snappy back-out feel.
// Pattern lifted from locca's src/ui.ts.
//
// Also injects an explicit `input` stream into every interactive prompt
// (text / password / confirm / select). On macOS, Bun's `process.stdin`
// doesn't deliver bytes when the binary was launched from a piped parent
// (oven-sh/bun#13374) — which is exactly the `curl|sh → exec subwave init
// </dev/tty` path. Opening /dev/tty ourselves as a fresh ReadStream and
// passing it as `input` sidesteps the broken pipeline. See cli/src/tty.ts
// and cli/scripts/patch-clack.mjs.

import * as clack from '@clack/prompts';
import pc from 'picocolors';
import readline from 'node:readline';
import { getInteractiveInput, inPipedStdinDangerZone } from './tty.ts';

// Inject an explicit input stream into the four interactive prompts.
// When no /dev/tty is available (CI, headless), `input` is undefined and
// @clack/core falls back to its default (process.stdin). spinner/cancel/
// isCancel and any other passthrough exports stay as-is.
const interactiveInput = getInteractiveInput();
function withInput<T>(opts: T): T {
  if (!interactiveInput) return opts;
  return { ...opts, input: interactiveInput };
}

// Defense-in-depth against oven-sh/bun#13374: when the process was launched
// from a piped parent (process.stdin isn't a TTY), an interactive prompt can
// hang un-killably because Bun never delivers stdin bytes — not even on the
// freshly-opened /dev/tty stream. The installer no longer drives interactive
// prompts through the pipe (it uses `subwave init --yes`), but if anything ever
// does again, this watchdog turns the silent hang into a fast, actionable exit.
//
// Armed lazily on the FIRST interactive prompt, and only in the danger zone, so
// normal direct-terminal users (isTTY === true) never see it and can pause at a
// prompt indefinitely. process.exit works even with a dead stdin, so this
// guarantees the prompt is escapable.
const HANG_WATCHDOG_MS = Number(process.env.SUBWAVE_PROMPT_WATCHDOG_MS) || 60_000;
let watchdogArmed = false;
function armHangWatchdog(): void {
  if (watchdogArmed) return;
  watchdogArmed = true;
  if (!inPipedStdinDangerZone()) return;

  const timer = setTimeout(() => {
    process.stderr.write(
      '\n⚠ Input isn\'t reaching the prompt — known Bun/macOS issue (oven-sh/bun#13374)\n' +
      '  when launched through a pipe. Run `subwave init` directly in a terminal,\n' +
      '  or `subwave init --yes` for defaults.\n',
    );
    process.exit(1);
  }, HANG_WATCHDOG_MS);
  // Don't let the watchdog itself hold the event loop open.
  timer.unref?.();

  const clear = (): void => clearTimeout(timer);
  // Any byte on either the /dev/tty stream or process.stdin means input is
  // flowing — stand down.
  interactiveInput?.once('data', clear);
  interactiveInput?.once('keypress', clear);
  process.stdin.once('data', clear);
  process.stdin.once('keypress', clear);
}

const p: typeof clack = {
  ...clack,
  text: (opts) => { armHangWatchdog(); return clack.text(withInput(opts)); },
  password: (opts) => { armHangWatchdog(); return clack.password(withInput(opts)); },
  confirm: (opts) => { armHangWatchdog(); return clack.confirm(withInput(opts)); },
  select: (opts) => { armHangWatchdog(); return clack.select(withInput(opts)); },
};

export { p, pc };

export const MENU_BACK = Symbol('menu-back');

// Brand accent — hot vermilion, matching the web UI's `--accent` token
// (oklch(0.62 0.22 25) ≈ #d94b2a). picocolors ships only the 16 ANSI colors
// and none of them land near vermilion, so emit a truecolor SGR sequence
// directly; fall back to plain text when color is unsupported (pipes,
// NO_COLOR, dumb terminals) so the CLI never leaks raw escape codes.
const VERMILION = '\x1b[38;2;217;75;42m';
export function accent(text: string): string {
  return pc.isColorSupported ? `${VERMILION}${text}\x1b[39m` : text;
}

let menuMode = false;
let rlInstalled = false;

// Translate Esc → Ctrl-C only while menu mode is on. Clack treats Ctrl-C as
// a cancel sentinel, which the menu loop interprets as "back to the
// previous screen". When menu mode is off (e.g. during `subwave setup`),
// Esc has no special meaning and the prompts work as Clack ships them.
function installEscHandler(): void {
  if (rlInstalled) return;
  rlInstalled = true;
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', (_str: string, key: readline.Key) => {
    if (menuMode && key && key.name === 'escape') {
      // Emit a synthetic Ctrl-C; Clack's keypress handler treats it as cancel.
      process.stdin.emit('keypress', '\x03', { ctrl: true, name: 'c' });
    }
  });
}

export function setMenuMode(on: boolean): void {
  menuMode = on;
  if (on) installEscHandler();
}

export function isMenuMode(): boolean {
  return menuMode;
}

// Unwrap a Clack prompt result. If the operator cancelled (Esc or Ctrl-C)
// and we're inside the menu loop, throw MENU_BACK so the loop can redraw;
// otherwise treat it as an exit.
export function exitIfCancelled<T>(value: T | symbol, opts: { backOnCancel?: boolean } = {}): T {
  const { backOnCancel = true } = opts;
  if (p.isCancel(value)) {
    if (backOnCancel && menuMode) throw MENU_BACK;
    p.cancel('Cancelled.');
    process.exit(1);
  }
  return value as T;
}

export function banner(tagline?: string): void {
  const lines = [
    accent(pc.bold('  ███████╗██╗   ██╗██████╗     ██╗██╗    ██╗ █████╗ ██╗   ██╗███████╗')),
    accent(pc.bold('  ██╔════╝██║   ██║██╔══██╗   ██╔╝██║    ██║██╔══██╗██║   ██║██╔════╝')),
    accent(pc.bold('  ███████╗██║   ██║██████╔╝  ██╔╝ ██║ █╗ ██║███████║██║   ██║█████╗  ')),
    accent(pc.bold('  ╚════██║██║   ██║██╔══██╗ ██╔╝  ██║███╗██║██╔══██║╚██╗ ██╔╝██╔══╝  ')),
    accent(pc.bold('  ███████║╚██████╔╝██████╔╝██╔╝   ╚███╔███╔╝██║  ██║ ╚████╔╝ ███████╗')),
    accent(pc.bold('  ╚══════╝ ╚═════╝ ╚═════╝ ╚═╝     ╚══╝╚══╝ ╚═╝  ╚═╝  ╚═══╝  ╚══════╝')),
  ];
  console.log();
  for (const line of lines) console.log(line);
  if (tagline) console.log('  ' + pc.dim(tagline));
  console.log();
}

export function header(text: string): void {
  const padLen = Math.max(0, 60 - text.length);
  console.log();
  console.log(pc.bold(accent('━━ ' + text + ' ' + '━'.repeat(padLen))));
}

export function section(text: string): void {
  console.log();
  console.log(pc.bold(text));
}

// Status badges. Used by status/doctor renderers. The unicode glyphs match
// what locca uses so existing operator muscle memory transfers.
export function ok(msg: string): void { console.log(`  ${pc.green('●')} ${msg}`); }
export function warn(msg: string): void { console.log(`  ${pc.yellow('⚠')} ${msg}`); }
export function err(msg: string): void { console.log(`  ${pc.red('✗')} ${msg}`); }
export function info(msg: string): void { console.log(`  ${accent('·')} ${msg}`); }
export function muted(msg: string): void { console.log(`  ${pc.dim(msg)}`); }

// Small helper so commands can pause and let the operator read output
// before the menu loop redraws. No-op when not in menu mode (one-shot
// command invocations should just return).
export async function pauseForEnter(): Promise<void> {
  if (!menuMode) return;
  await p.text({
    message: pc.dim('Press Enter to return to the menu…'),
    defaultValue: '',
    placeholder: '',
  });
}
