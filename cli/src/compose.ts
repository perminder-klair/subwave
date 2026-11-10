// Compose-environment detection — which compose file is up, where to send
// `docker compose`, and what URLs the controller answers on. Detection logic
// mirrors scripts/health-check.sh.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSubwaveHome } from './util.ts';

// `prod-byo` is prod without the bundled Caddy: a prod sibling everywhere except
// the URL helpers, which point at host-bound service ports, not the Caddy edge.
export type ComposeEnv = 'dev' | 'prod' | 'prod-byo' | 'down';

export interface ComposeFile {
  env: Exclude<ComposeEnv, 'down'>;
  file: string; // path relative to SUBWAVE_HOME (e.g. "docker-compose.yml")
  abs: string;  // absolute path
}

// Order matters: detectCompose() takes the first file with running containers,
// so prod leads and wins on ambiguity. Computed lazily because `subwave init`
// imports this module for the env enum before a home exists to resolve.
let _composeFiles: ComposeFile[] | null = null;
export function getComposeFiles(): ComposeFile[] {
  if (_composeFiles) return _composeFiles;
  const home = getSubwaveHome();
  _composeFiles = [
    { env: 'prod',     file: 'docker-compose.yml',     abs: resolve(home, 'docker-compose.yml') },
    { env: 'prod-byo', file: 'docker-compose.byo.yml', abs: resolve(home, 'docker-compose.byo.yml') },
    { env: 'dev',      file: 'docker-compose.dev.yml', abs: resolve(home, 'docker-compose.dev.yml') },
  ];
  return _composeFiles;
}

// The two prods share every operational concern, so use this rather than
// `env === 'prod'`.
export function isProdEnv(env: ComposeEnv): env is 'prod' | 'prod-byo' {
  return env === 'prod' || env === 'prod-byo';
}

export interface ComposeStatus {
  env: ComposeEnv;
  file: ComposeFile | null;
  services: Record<string, string>; // service name → docker state
}

// Every compose file shares one project name, so `ps -q` returns the same
// containers whichever file is asked about; the answer comes from the
// `com.docker.compose.project.config_files` label, which records the real file.
export function detectCompose(): ComposeStatus {
  for (const f of getComposeFiles()) {
    if (!existsSync(f.abs)) continue;
    const ids = spawnSync(
      'docker',
      ['compose', '-f', f.file, 'ps', '-q'],
      { cwd: getSubwaveHome(), encoding: 'utf8' },
    );
    if (ids.status !== 0 || ids.stdout.trim() === '') continue;

    const labelFile = detectConfigFileFromContainers(ids.stdout.trim().split('\n'));
    if (labelFile) {
      const match = getComposeFiles().find((c) => c.abs === labelFile);
      if (match) return { env: match.env, file: match, services: listServices(match) };
    }
    // Unreadable label: trust the file we asked about rather than say "down".
    return { env: f.env, file: f, services: listServices(f) };
  }
  return { env: 'down', file: null, services: {} };
}

// Docker stores an absolute path in the label.
function detectConfigFileFromContainers(containerIds: string[]): string | null {
  for (const id of containerIds) {
    const r = spawnSync(
      'docker',
      ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project.config_files" }}', id],
      { encoding: 'utf8' },
    );
    if (r.status === 0) {
      const v = r.stdout.trim();
      // Stacked -f flags produce a comma-separated list; the first is primary.
      if (v) return v.split(',')[0]?.trim() ?? null;
    }
  }
  return null;
}

function listServices(f: ComposeFile): Record<string, string> {
  const r = spawnSync(
    'docker',
    ['compose', '-f', f.file, 'ps', '--format', 'json', '--all'],
    { cwd: getSubwaveHome(), encoding: 'utf8' },
  );
  if (r.status !== 0) return {};
  const out: Record<string, string> = {};
  // Docker emits newline-delimited JSON, not an array; tolerate either in case
  // the format changes under us.
  const raw = r.stdout.trim();
  if (!raw) return out;
  const tryRows = (text: string): Array<{ Service?: string; State?: string }> => {
    if (text.startsWith('[')) {
      try { return JSON.parse(text); } catch { return []; }
    }
    const rows: Array<{ Service?: string; State?: string }> = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip bad lines */ }
    }
    return rows;
  };
  for (const row of tryRows(raw)) {
    if (row.Service && row.State) out[row.Service] = row.State;
  }
  return out;
}

// Image refs of the project's containers, running or stopped. `start` warns off
// this when an up stack differs from the version the .env pins.
export function runningImageRefs(file: ComposeFile): string[] {
  const r = spawnSync(
    'docker',
    ['compose', '-f', file.file, 'ps', '--format', 'json', '--all'],
    { cwd: getSubwaveHome(), encoding: 'utf8' },
  );
  if (r.status !== 0) return [];
  const refs = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { Image?: string };
      if (row.Image) refs.add(row.Image);
    } catch { /* skip bad lines */ }
  }
  return [...refs];
}

// Reads the same env vars the compose files bind with, so an operator who
// overrides a host binding doesn't leave the CLI looking at the wrong port.
function byoPort(name: 'WEB_PORT' | 'CONTROLLER_PORT' | 'ICECAST_PORT' | 'CADDY_PORT', fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Prod routes through Caddy; prod-byo goes straight to the host-bound
// controller port, since the operator's external proxy isn't in the picture.
export function apiBaseFor(env: ComposeEnv): string {
  if (env === 'prod') return `http://localhost:${byoPort('CADDY_PORT', 7700)}/api`;
  if (env === 'prod-byo') return `http://localhost:${byoPort('CONTROLLER_PORT', 7701)}`;
  return 'http://localhost:7701';
}

export function streamUrlFor(env: ComposeEnv): string {
  if (env === 'prod') return `http://localhost:${byoPort('CADDY_PORT', 7700)}/stream.mp3`;
  if (env === 'prod-byo') return `http://localhost:${byoPort('ICECAST_PORT', 7702)}/stream.mp3`;
  return 'http://localhost:7702/stream.mp3';
}

// Browser base URL for the web UI. In dev this is the Next.js dev server, which
// runs outside compose.
export function webBaseFor(env: ComposeEnv): string {
  if (env === 'prod') return `http://localhost:${byoPort('CADDY_PORT', 7700)}`;
  if (env === 'prod-byo') return `http://localhost:${byoPort('WEB_PORT', 7700)}`;
  return 'http://localhost:7700';
}

// `start`'s fallback when nothing runs and no preferredEnv is persisted. A clone
// carries all three compose files, so only the dev file plus .git identifies it.
// null means ambiguous (the standalone shape has both prod files).
export function inferEnvFromFilesystem(): Exclude<ComposeEnv, 'down'> | null {
  const home = getSubwaveHome();
  const hasDev = existsSync(resolve(home, 'docker-compose.dev.yml'));
  const hasProd = existsSync(resolve(home, 'docker-compose.yml'));
  const hasByo = existsSync(resolve(home, 'docker-compose.byo.yml'));
  const isClone = hasDev && existsSync(resolve(home, '.git'));

  if (isClone) return 'dev';
  if (hasProd && !hasByo) return 'prod';
  if (hasByo && !hasProd) return 'prod-byo';
  return null;
}

// Declared services, so the operator can pick one that isn't running.
export function listDeclaredServices(file: ComposeFile): string[] {
  const r = spawnSync(
    'docker',
    ['compose', '-f', file.file, 'config', '--services'],
    { cwd: getSubwaveHome(), encoding: 'utf8' },
  );
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}
