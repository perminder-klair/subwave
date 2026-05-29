// Thin wrappers around `docker compose <verb>` for the live env.
// Each function knows enough about the chosen compose file to invoke
// docker correctly; commands above this layer don't need to construct
// shell args themselves.

import { spawn, spawnSync } from 'node:child_process';
import type { ComposeFile } from './compose.ts';
import { getSubwaveHome } from './util.ts';

function args(file: ComposeFile, rest: string[]): string[] {
  return ['compose', '-f', file.file, ...rest];
}

// Run `docker compose up -d [--build] [--pull always]` and stream output to
// the user's terminal. Resolves with the docker exit code.
export function composeUp(
  file: ComposeFile,
  opts: { build?: boolean; pull?: 'always' | 'missing' } = {},
): Promise<number> {
  const a = ['up', '-d'];
  if (opts.build) a.push('--build');
  if (opts.pull) a.push('--pull', opts.pull);
  return run(file, a);
}

// `docker compose pull` for refreshing images without bringing the stack
// up. Use before composeUp() when the local cache may have a stale image
// tagged the same name (e.g. a previously-built local image masking the
// upstream GHCR release).
export function composePull(file: ComposeFile): Promise<number> {
  return run(file, ['pull']);
}

export function composeDown(file: ComposeFile): Promise<number> {
  // Deliberately never `-v` — that would wipe the bind-mounted state dir
  // and all of the operator's settings, archives, jingles. Confirm in the
  // command layer if the operator ever needs that.
  return run(file, ['down']);
}

// `docker compose down` with optional `-v` (remove named volumes) and
// `--rmi all` (remove the service images). Only `subwave uninstall` reaches
// for these — the command layer gates them behind explicit flags + a confirm,
// because `-v` is destructive and `--rmi all` forces a re-pull next install.
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

// `docker compose up -d --force-recreate [service]` — bounces the container
// AND re-reads .env, without rebuilding the image. The right primitive for
// "restart this on a standalone install" (where there's no build context to
// rebuild from) and "restart the whole stack and pick up .env changes".
// Omit `service` to recreate every service in the stack.
export function composeUpRecreate(file: ComposeFile, service?: string): Promise<number> {
  const a = ['up', '-d', '--force-recreate'];
  if (service) a.push(service);
  return run(file, a);
}

// Tail logs for one or more services. Inherits stdio so the operator's
// Ctrl-C breaks out cleanly. Pass an empty array for "all services".
export function composeLogs(file: ComposeFile, services: string[], tail = 200): Promise<number> {
  const a = ['logs', '-f', `--tail=${tail}`, ...services];
  return run(file, a);
}

// Fire-and-forget runner that streams stdio to the operator.
function run(file: ComposeFile, rest: string[]): Promise<number> {
  return new Promise((resolveP) => {
    const child = spawn('docker', args(file, rest), {
      cwd: getSubwaveHome(),
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolveP(code ?? 1));
  });
}

// Check whether `docker info` succeeds. Used by doctor as the first probe;
// if this fails, every downstream check is meaningless.
export function dockerDaemonOk(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return r.status === 0;
}

// Post-mortem probe: did the previous compose call fail because the operator's
// user can't talk to the docker daemon socket? Distinguishes "user not in the
// docker group" (which has a one-liner fix) from "daemon not running" /
// "docker not installed" so we can tailor the hint we surface (see #156).
export function dockerSocketPermissionDenied(): boolean {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (r.status === 0) return false;
  const blob = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.toLowerCase();
  // Match the common kernel/daemon messages. Don't rely on a single phrase —
  // dockerd, podman-emulating-docker, and rootless setups all word it slightly
  // differently, but they all mention "permission denied" alongside the socket.
  return blob.includes('permission denied') && blob.includes('docker.sock');
}

// `docker compose exec -T <svc> <cmd...>`. Used for in-container probes
// (e.g. telnet to liquidsoap inside the broadcast container). Not used in
// the v1 doctor but kept here so we don't have to retrofit the abstraction.
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
