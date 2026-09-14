// The Next.js web dev server, dev mode only. Spawned detached with output to
// state/logs/web-dev.log. Whoever holds :7700 is the source of truth for "is it
// running?"; the pid file is a convenience and can go stale.

import { existsSync, openSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getSubwaveHome, getStateDir } from './util.ts';
import { p, pc, accent, exitIfCancelled, header, ok, warn, muted } from './ui.ts';

// Functions, not constants: evaluating these at module load would force home
// resolution even on `subwave --version`.
function webDir(): string { return resolve(getSubwaveHome(), 'web'); }
function logDir(): string { return resolve(getStateDir(), 'logs'); }
export function getWebDevLog(): string { return resolve(logDir(), 'web-dev.log'); }
export function getWebDevPid(): string { return resolve(logDir(), 'web-dev.pid'); }

export interface PortHolder {
  pid: number;
  command: string;
}

// Prefers `lsof` (macOS), falling back to `ss` (base Arch/Debian).
export function whoHolds7700(): PortHolder | null {
  const lsof = spawnSync(
    'lsof',
    ['-nP', '-iTCP:7700', '-sTCP:LISTEN', '-F', 'pc'],
    { encoding: 'utf8' },
  );
  if (lsof.status === 0 && lsof.stdout) {
    // -F output tags each line: 'p' = pid, 'c' = command.
    let pid = 0;
    let command = '';
    for (const line of lsof.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('c')) command = line.slice(1);
    }
    if (pid) return { pid, command };
  }
  // lsof missing or silent → try ss. lsof present and non-zero means the port
  // is genuinely free, so don't second-guess it.
  if (lsof.error || (lsof.status === 0 && !lsof.stdout)) {
    const ss = spawnSync(
      'ss',
      ['-ltnpH', 'sport = :7700'],
      { encoding: 'utf8' },
    );
    if (ss.status === 0 && ss.stdout) {
      // ss truncates the command to ~15 chars (`next-server (v1`); strip the
      // half-eaten version suffix so isWebDevCommand() can match.
      const match = ss.stdout.match(/users:\(\("([^"]+)",pid=(\d+),/);
      if (match) {
        const command = match[1].replace(/\s*\(v\d.*$/, '').trim();
        const pid = Number(match[2]);
        if (pid) return { pid, command };
      }
    }
  }
  return null;
}

// Two entries because the probes disagree: macOS `lsof` names the launching
// node interpreter, Linux `ss` names the actual `next-server` binary.
const WEB_DEV_COMMANDS = new Set(['node', 'next-server']);
export function isWebDevCommand(command: string): boolean {
  return WEB_DEV_COMMANDS.has(command);
}

export function webDepsInstalled(): boolean {
  return existsSync(resolve(webDir(), 'node_modules'));
}

// stdio inherited so the operator sees progress.
export function installWebDeps(): Promise<number> {
  return new Promise((resolveP) => {
    const child = spawn('npm', ['install'], { cwd: webDir(), stdio: 'inherit' });
    child.on('exit', (code) => resolveP(code ?? 1));
  });
}

// Returns the npm wrapper's pid. npm forwards SIGTERM to `next dev`, so killing
// it stops the whole tree cleanly.
export function spawnWebDevDetached(): { pid: number; logFile: string } {
  mkdirSync(logDir(), { recursive: true });
  // Append — repeated runs share one log, and rotation is the operator's call.
  const fd = openSync(getWebDevLog(), 'a');
  const child = spawn('npm', ['run', 'dev'], {
    cwd: webDir(),
    stdio: ['ignore', fd, fd],
    detached: true,
    // FORCE_COLOR=0 keeps SGR escapes out of the log file.
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  if (!child.pid) {
    throw new Error('failed to spawn `npm run dev`');
  }
  child.unref();
  writeFileSync(getWebDevPid(), String(child.pid));
  return { pid: child.pid, logFile: getWebDevLog() };
}

export async function waitForWebDev(
  timeoutMs: number,
  onTick?: (ms: number) => void,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    onTick?.(Date.now() - start);
    try {
      const r = await fetch('http://localhost:7700', {
        signal: AbortSignal.timeout(1500),
      });
      // Any status, 404 and 500 included, proves the server is up.
      if (r.status > 0) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// Keyed off the port holder, not the pid file, which goes stale. Refuses to
// kill anything that isn't recognisably a dev server.
export function stopWebDev(): { stopped: boolean; reason?: string } {
  const holder = whoHolds7700();
  if (!holder) {
    cleanupPidFile();
    return { stopped: false, reason: 'not running' };
  }
  if (!isWebDevCommand(holder.command)) {
    return { stopped: false, reason: `:7700 held by ${holder.command} (pid ${holder.pid}) — refusing to kill` };
  }
  try {
    process.kill(holder.pid, 'SIGTERM');
  } catch (e) {
    return { stopped: false, reason: `kill ${holder.pid}: ${(e as Error).message}` };
  }
  // Graceful shutdown is usually <500ms, but Next takes a beat mid-compile.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!whoHolds7700()) break;
    spawnSync('sleep', ['0.2']);
  }
  cleanupPidFile();
  return { stopped: true };
}

function cleanupPidFile(): void {
  try { unlinkSync(getWebDevPid()); } catch { /* ignore */ }
}

// 'running' covers reusing a server that was already up.
export type WebDevState = 'running' | 'skipped';

export async function maybeStartWebDev(opts: { askFirst?: boolean } = {}): Promise<WebDevState> {
  header('Web dev server');
  const holder = whoHolds7700();
  if (holder) {
    if (isWebDevCommand(holder.command)) {
      ok(`Already running on :7700 (pid ${holder.pid})`);
      return 'running';
    }
    warn(`:7700 is held by ${holder.command} (pid ${holder.pid}) — not a node dev server.`);
    if (holder.command === 'ControlCenter') {
      muted('macOS AirPlay Receiver uses this port. Disable it in System Settings → General → AirDrop & Handoff → AirPlay Receiver, then start the web dev server.');
    } else {
      muted('Free :7700, then run `npm --prefix web run dev`.');
    }
    return 'skipped';
  }

  if (opts.askFirst !== false) {
    const want = exitIfCancelled(await p.confirm({
      message: 'Start the web dev server now? (`npm run dev` on :7700, backgrounded)',
      initialValue: true,
    }), { backOnCancel: false });
    if (!want) return 'skipped';
  }

  if (!webDepsInstalled()) {
    header('Installing web/ dependencies (first run)');
    const code = await installWebDeps();
    if (code !== 0) {
      warn(`npm install exited ${code} — skipping web dev start.`);
      muted('Resolve the install error, then run `npm --prefix web run dev` yourself.');
      return 'skipped';
    }
  }

  let pid: number;
  let logFile: string;
  try {
    ({ pid, logFile } = spawnWebDevDetached());
  } catch (e) {
    warn(`failed to spawn npm run dev: ${(e as Error).message}`);
    return 'skipped';
  }
  muted(`pid ${pid} — log: ${logFile}`);
  muted(`pid file: ${getWebDevPid()}`);

  const sp = p.spinner();
  sp.start('Waiting for next dev to respond on :7700…');
  const ready = await waitForWebDev(30_000, (ms) => {
    sp.message(`Waiting… ${Math.floor(ms / 1000)}s`);
  });
  sp.stop(ready ? `Web dev on ${accent('http://localhost:7700')}` : pc.yellow('Web dev not responding after 30s — continuing'));
  if (!ready) {
    warn(`web dev did not respond within 30s. Check ${getWebDevLog()}.`);
  }
  return 'running';
}

// 0 when absent or unparseable.
export function readWebDevPid(): number {
  try {
    const n = Number(readFileSync(getWebDevPid(), 'utf8').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
