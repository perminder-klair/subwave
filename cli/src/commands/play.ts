// `subwave play [dev|prod]` — launch the terminal player (TUI) pointed at
// the running stack. The TUI is its own package under /tui/; this command
// resolves the right controller + Icecast URLs for the live compose env
// and hands off to `tui/bin/subwave-tui.js`.
//
// The TUI is a full-screen Ink app — once spawned it owns the terminal
// until the listener quits, then control returns here (or to the menu).

import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  detectCompose,
  apiBaseFor,
  streamUrlFor,
  type ComposeEnv,
} from '../compose.ts';
import { REPO_ROOT } from '../util.ts';
import {
  exitIfCancelled,
  header,
  info,
  warn,
  err,
  muted,
  p,
  pauseForEnter,
  isMenuMode,
  setMenuMode,
} from '../ui.ts';

const TUI_DIR = resolve(REPO_ROOT, 'tui');
const TUI_BIN = resolve(TUI_DIR, 'bin', 'subwave-tui.js');

export interface PlayOpts {
  envArg?: Exclude<ComposeEnv, 'down'>;
}

export async function runPlayCommand(opts: PlayOpts = {}): Promise<void> {
  if (!existsSync(TUI_BIN)) {
    header('TUI not found');
    err(`expected the terminal player at ${TUI_BIN}`);
    await pauseForEnter();
    return;
  }

  // Which stack are we listening to? Explicit arg wins; otherwise follow
  // whatever's currently up; if nothing's up, ask. (The TUI still runs as
  // a read-only dashboard when the stack is down — env just decides URLs.)
  type PlayableEnv = Exclude<ComposeEnv, 'down'>;
  let env: PlayableEnv;
  if (opts.envArg) {
    env = opts.envArg;
  } else {
    const detected = detectCompose();
    if (detected.env !== 'down') {
      env = detected.env;
    } else {
      env = exitIfCancelled(await p.select<PlayableEnv>({
        message: 'Stack is down — which env should the player target?',
        options: [
          { value: 'dev',      label: 'dev',              hint: 'controller :7701 · stream :7702' },
          { value: 'prod',     label: 'prod',             hint: 'Caddy edge :7700' },
          { value: 'prod-byo', label: 'prod (BYO proxy)', hint: 'controller :7701 · stream :7702' },
        ],
      }));
    }
  }

  // The TUI carries its own dependency tree (ink, react). It's a separate
  // package, so a fresh checkout won't have node_modules until installed.
  if (!existsSync(resolve(TUI_DIR, 'node_modules'))) {
    warn('the terminal player has no node_modules yet — it needs `npm install` first.');
    const doInstall = exitIfCancelled(await p.confirm({
      message: 'Run `npm install` in tui/ now?',
    }));
    if (!doInstall) {
      muted('skipped — run `npm install` inside tui/ yourself, then retry.');
      await pauseForEnter();
      return;
    }
    const r = spawnSync('npm', ['install'], { cwd: TUI_DIR, stdio: 'inherit' });
    if (r.status !== 0) {
      err('npm install failed — see output above.');
      await pauseForEnter();
      return;
    }
  }

  const apiUrl = apiBaseFor(env);
  const streamUrl = streamUrlFor(env);

  header('Terminal player');
  info(`env=${env} · api=${apiUrl}`);
  muted('q / Ctrl-C inside the player returns here.');
  console.log();

  // Drop menu mode for the duration: the Esc→Ctrl-C translation in ui.ts
  // must not leak keystrokes into the Ink app, which does its own raw-mode
  // input handling. Restore it afterwards so the menu loop behaves.
  const wasMenu = isMenuMode();
  if (wasMenu) setMenuMode(false);
  try {
    await new Promise<void>((resolveP) => {
      const child = spawn(
        'node',
        [TUI_BIN, '--api', apiUrl, '--stream', streamUrl],
        { cwd: TUI_DIR, stdio: 'inherit' },
      );
      child.on('exit', () => resolveP());
    });
  } finally {
    if (wasMenu) setMenuMode(true);
  }
}
