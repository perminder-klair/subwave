// Main menu loop. Status-aware — the top-level actions adapt to what's
// currently running (start vs stop vs restart). Esc inside any submenu
// throws MENU_BACK, which is caught here and treated as "re-render".
//
// Mirrors locca's src/menu.ts pattern.

import { detectCompose } from './compose.ts';
import { setMenuMode, MENU_BACK, banner, header, ok, warn, muted, exitIfCancelled, p, pc } from './ui.ts';
import { whoHolds7700, isWebDevCommand } from './web-dev.ts';
import { runStatusCommand } from './commands/status.ts';
import { runDoctorCommand } from './commands/doctor.ts';
import { runStartCommand } from './commands/start.ts';
import { runStopCommand } from './commands/stop.ts';
import { runRestartCommand } from './commands/restart.ts';
import { runLogsCommand } from './commands/logs.ts';
import { runOpenWebCommand } from './commands/open-web.ts';
import { runSetupCommand } from './commands/setup.ts';
import { runSyncCommand } from './commands/sync.ts';
import { getSubwaveHome } from './util.ts';
import { isCloneMode } from './home.ts';
import { resolveInstallMode, detectDrift, hasDrift } from './compose-sync.ts';

export async function runMenu(): Promise<void> {
  setMenuMode(true);
  banner('operator console');

  // Header line — one quick render before the main select. Hits docker
  // ps only; no controller HTTP call so the menu pops up instantly even
  // when the stack is unreachable.
  const compose = detectCompose();
  if (compose.env === 'down') {
    warn('stack down');
  } else {
    let running = Object.values(compose.services).filter((s) => s === 'running').length;
    let total = Object.keys(compose.services).length;
    // In dev the web UI is a host-side `npm run dev` process, not a compose
    // service — fold it into the running/total tally so the banner reflects
    // the whole rig.
    if (compose.env === 'dev') {
      const holder = whoHolds7700();
      total += 1;
      // `next dev` reports as `next-server` on Linux, `node` on macOS — match
      // both (isWebDevCommand), else the banner undercounts on Linux.
      if (holder && isWebDevCommand(holder.command)) running += 1;
    }
    ok(`stack up · env=${pc.bold(compose.env)} · ${running}/${total} running`);
  }
  console.log();

  // Top-level menu. Build options based on stack state so the operator
  // only sees what makes sense right now (locca pattern).
  const options: Array<{ value: string; label: string; hint?: string }> = [];

  options.push({ value: 'status', label: 'status', hint: 'compose + now-playing + recent events' });
  options.push({ value: 'doctor', label: 'doctor', hint: 'full diagnostic sweep' });
  options.push({ value: 'listen', label: 'listen', hint: 'open the web player in a browser' });
  options.push({ value: 'admin', label: 'admin', hint: 'open the admin console in a browser' });

  if (compose.env === 'down') {
    options.push({ value: 'start', label: 'start', hint: 'docker compose up -d' });
  } else {
    options.push({ value: 'restart', label: 'restart', hint: 'rebuild / restart a single service' });
    options.push({ value: 'logs', label: 'logs', hint: 'tail docker compose logs' });
    options.push({ value: 'stop', label: 'stop', hint: 'docker compose down' });
  }
  options.push({ value: 'setup', label: 'setup', hint: 're-run the install wizard' });
  // Surface `sync` only when the on-disk compose has fallen behind the binary
  // — so the operator sees it exactly when it matters (see #1043).
  if (composeFilesDrifted()) {
    options.push({ value: 'sync', label: 'sync', hint: pc.yellow('compose files behind this CLI — refresh them') });
  }
  options.push({ value: 'quit', label: pc.dim('quit') });

  let choice: string;
  try {
    choice = exitIfCancelled(await p.select({
      message: 'What do you want to do?',
      options,
    }), { backOnCancel: false });
  } catch (e) {
    if (e === MENU_BACK) return runMenu();
    throw e;
  }

  if (choice === 'quit') {
    setMenuMode(false);
    console.log();
    muted('goodbye.');
    return;
  }

  try {
    await dispatch(choice);
  } catch (e) {
    if (e !== MENU_BACK) throw e;
    // Esc inside a command — just loop back.
  }
  console.log();
  return runMenu();
}

async function dispatch(choice: string): Promise<void> {
  switch (choice) {
    case 'status':  return runStatusCommand();
    case 'doctor':  return runDoctorCommand();
    case 'listen':  return runOpenWebCommand('listen');
    case 'admin':   return runOpenWebCommand('admin');
    case 'start':   return runStartCommand();
    case 'stop':    return runStopCommand();
    case 'restart': return runRestartCommand();
    case 'logs':    return runLogsCommand();
    case 'sync':    return runSyncCommand();
    case 'setup': {
      // The setup wizard owns its own Clack lifecycle. Temporarily disable
      // menu-mode so its Esc handling works normally; restore after.
      setMenuMode(false);
      try { await runSetupCommand(); }
      finally { setMenuMode(true); }
      return;
    }
    default:
      header('Unknown choice');
      muted(`'${choice}' is not a known command.`);
      return;
  }
}

// Cheap on-disk drift probe for the menu (a few readFileSync — no docker/HTTP).
// Standalone installs only; any resolution error → no hint (never blocks the
// menu render).
function composeFilesDrifted(): boolean {
  try {
    const home = getSubwaveHome();
    if (isCloneMode(home)) return false;
    const mode = resolveInstallMode(home);
    return mode ? hasDrift(detectDrift(home, mode)) : false;
  } catch {
    return false;
  }
}
