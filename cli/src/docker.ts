// Thin wrappers around `docker compose <verb>`, so no command above this layer
// has to construct shell args itself.

import { spawn, spawnSync } from 'node:child_process';
import type { ComposeFile } from './compose.ts';
import { getRootEnv, getSubwaveHome, parseEnvFile } from './util.ts';

function args(file: ComposeFile, rest: string[]): string[] {
  return ['compose', ...composeFileArgs(file), ...rest];
}
/** Preserve a configured Compose overlay when the CLI must pass -f explicitly. */
export function composeFileArgs(file: ComposeFile): string[] {
  const fromEnv = process.env.COMPOSE_FILE?.trim() || parseEnvFile(getRootEnv()).COMPOSE_FILE?.trim();
  if (!fromEnv) return ['-f', file.file];
  const configured = fromEnv.split(":").map((part) => part.trim()).filter(Boolean);
  const home = getSubwaveHome();
  const primary = configured[0];
  const resolveFile = (value: string) => value.startsWith("/") ? value : `${home}/${value}`;
  if (!primary || resolveFile(primary) !== resolveFile(file.file)) return ['-f', file.file];
  return configured.flatMap((part) => ['-f', part]);
}


export function composeUp(
  file: ComposeFile,
  opts: { build?: boolean; pull?: 'always' | 'missing' } = {},
): Promise<number> {
  const a = ['up', '-d'];
  if (opts.build) a.push('--build');
  if (opts.pull) a.push('--pull', opts.pull);
  return run(file, a);
}

// Run before composeUp() when a locally-built image may be masking the upstream
// GHCR release under the same tag.
export function composePull(file: ComposeFile): Promise<number> {
  return run(file, ['pull']);
}

export function composeDown(file: ComposeFile): Promise<number> {
  // Never `-v` here — that wipes the state dir and with it every setting,
  // archive and jingle. composeDownFull() is the gated way to ask for that.
  return run(file, ['down']);
}

// `subwave uninstall` only. Both flags are expensive to get wrong: `-v` is
// destructive and `--rmi all` forces a full re-pull, so the command layer gates
// them behind an explicit flag plus a confirm.
export function composeDownFull(
  file: ComposeFile,
  opts: { volumes?: boolean; rmi?: boolean } = {},
): Promise<number> {
  const a = ['down', '--remove-orphans'];
  if (opts.volumes) a.push('-v');
  if (opts.rmi) a.push('--rmi', 'all');
  return run(file, a);
}

export function composeRestart(file: ComposeFile, service: string): Promise<number> {
  return run(file, ['restart', service]);
}

export function composeUpBuild(file: ComposeFile, service: string): Promise<number> {
  return run(file, ['up', '-d', '--build', service]);
}

// Bounces the container AND re-reads .env without rebuilding — the right
// primitive on a standalone install, which has no build context to rebuild
// from. Omit `service` to recreate the whole stack.
export function composeUpRecreate(file: ComposeFile, service?: string): Promise<number> {
  const a = ['up', '-d', '--force-recreate'];
  if (service) a.push(service);
  return run(file, a);
}

// Empty `services` tails everything.
export function composeLogs(file: ComposeFile, services: string[], tail = 200): Promise<number> {
  const a = ['logs', '-f', `--tail=${tail}`, ...services];
  return run(file, a);
}

// stdio is inherited throughout, so output streams live and Ctrl-C breaks out.
function run(file: ComposeFile, rest: string[]): Promise<number> {
  return new Promise((resolveP) => {
    const child = spawn('docker', args(file, rest), {
      cwd: getSubwaveHome(),
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolveP(code ?? 1));
  });
}

// doctor's first probe — every downstream check is meaningless if this fails.
export function dockerDaemonOk(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return r.status === 0;
}

// Post-mortem on a failed compose call: separates "user not in the docker
// group", which has a one-line fix, from "daemon down" / "docker missing", so
// the hint can name the actual problem (#156).
export function dockerSocketPermissionDenied(): boolean {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (r.status === 0) return false;
  const blob = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.toLowerCase();
  // Two loose substrings rather than one phrase: dockerd, podman-as-docker and
  // rootless setups each word this differently, but all name the socket.
  return blob.includes('permission denied') && blob.includes('docker.sock');
}

// For in-container probes — reading a log a container owns, telnetting
// liquidsoap. Synchronous and timeout-bounded: callers are diagnostics.
export function composeExec(
  file: ComposeFile,
  service: string,
  cmd: string[],
  timeoutMs = 5000,
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('docker', args(file, ['exec', '-T', service, ...cmd]), {
    cwd: getSubwaveHome(),
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}
