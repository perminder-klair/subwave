// Shared UI helpers over @clack/prompts + picocolors. Two things beyond styling:
// "menu mode", where Esc throws MENU_BACK for the menu loop to catch; and an
// explicit `input` stream on every prompt, working around oven-sh/bun#13374
// (see cli/src/tty.ts and cli/scripts/patch-clack.mjs).

import * as clack from '@clack/prompts';
import pc from 'picocolors';
import readline from 'node:readline';
import { getInteractiveInput, inPipedStdinDangerZone } from './tty.ts';

// Undefined with no /dev/tty (CI, headless), which leaves @clack/core on its
// process.stdin default.
const interactiveInput = getInteractiveInput();
function withInput<T>(opts: T): T {
  if (!interactiveInput) return opts;
  return { ...opts, input: interactiveInput };
}

// Turns a #13374 unkillable hang into a fast, actionable exit. Armed lazily and
// only in the danger zone, so a direct-terminal operator can sit at a prompt
// indefinitely.
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
  timer.unref?.(); // never hold the event loop open

  // A byte on either stream means input is flowing — stand down.
  const clear = (): void => clearTimeout(timer);
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

// Matches the web UI's `--accent` token (≈ #d94b2a). Raw truecolor SGR because
// no picocolors ANSI color is close; guarded so NO_COLOR/pipes see no escapes.
const VERMILION = '\x1b[38;2;217;75;42m';
export function accent(text: string): string {
  return pc.isColorSupported ? `${VERMILION}${text}\x1b[39m` : text;
}

let menuMode = false;
let rlInstalled = false;

// Clack has no Esc concept, so map Esc onto its Ctrl-C cancel sentinel, which
// the menu loop reads as "back one screen". Outside menu mode Esc stays inert.
function installEscHandler(): void {
  if (rlInstalled) return;
  rlInstalled = true;
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', (_str: string, key: readline.Key) => {
    if (menuMode && key && key.name === 'escape') {
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

// A cancel inside the menu loop means "go back"; anywhere else it means exit.
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

// Glyphs match locca's, so operator muscle memory transfers.
export function ok(msg: string): void { console.log(`  ${pc.green('●')} ${msg}`); }
export function warn(msg: string): void { console.log(`  ${pc.yellow('⚠')} ${msg}`); }
export function err(msg: string): void { console.log(`  ${pc.red('✗')} ${msg}`); }
export function info(msg: string): void { console.log(`  ${accent('·')} ${msg}`); }
export function muted(msg: string): void { console.log(`  ${pc.dim(msg)}`); }

// Lets the operator read output before the menu loop redraws. A no-op outside
// menu mode, where a one-shot command should just return.
export async function pauseForEnter(): Promise<void> {
  if (!menuMode) return;
  await p.text({
    message: pc.dim('Press Enter to return to the menu…'),
    defaultValue: '',
    placeholder: '',
  });
}
