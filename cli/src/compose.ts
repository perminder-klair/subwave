// Compose-environment detection. Every lifecycle command keys off this:
// which compose file is up, where to send `docker compose` invocations, and
// what API base URL to talk to the controller on.
//
// Logic mirrors scripts/health-check.sh — for each candidate compose file
// we ask docker for the running container IDs; the first one that returns
// non-empty output is "the" running stack.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSubwaveHome } from './util.ts';

// `prod-byo` is the "bring your own reverse proxy" variant — same as prod
// but without the bundled Caddy. Treat it as a prod sibling everywhere
// except for the URL helpers, which need to point at the host-bound service
// ports instead of the Caddy edge. Use `isProdEnv()` for "prod or prod-byo".
export type ComposeEnv = 'dev' | 'prod' | 'prod-byo' | 'down';

export interface ComposeFile {
  env: Exclude<ComposeEnv, 'down'>;
  file: string; // path relative to SUBWAVE_HOME (e.g. "docker-compose.yml")
  abs: string;  // absolute path
}

// `docker-compose.yml` is the production default (bundled Caddy) so a
// fresh-host `docker compose up -d` does the right thing. Dev moves to
// the explicit `.dev.yml`; BYO-proxy variant is `.byo.yml`. Probe order
// matters: detectCompose() returns the first file with running
// containers, so list prod first to prefer it on ambiguity.
//
// Computed lazily so importing this module doesn't trigger SUBWAVE_HOME
// resolution — `subwave init` needs to load this file (for the env enum)
// without yet having a home. Memoised after first call.
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

// `prod` and `prod-byo` differ in routing surface (bundled Caddy vs external
// proxy fronting host ports) but share every operational concern — admin
// gate is mandatory, the stack builds, listeners count, `stop` deserves a
// confirmation. Anywhere you would have written `env === 'prod'` for one of
// those concerns, write `isProdEnv(env)` instead.
export function isProdEnv(env: ComposeEnv): env is 'prod' | 'prod-byo' {
  return env === 'prod' || env === 'prod-byo';
}

export interface ComposeStatus {
  env: ComposeEnv;
  file: ComposeFile | null;
  // Map of service name → state ("running", "exited", "restarting", "created").
  services: Record<string, string>;
}

// Probe which compose stack (if any) is currently up.
//
// Both compose files use the same project name (derived from `docker/`),
// so `docker compose -f <file> ps -q` returns the same containers for
// either file. We can't rely on that. Instead we read the
// `com.docker.compose.project.config_files` label off the running
// containers — that's the actual file Docker remembers being launched
// with. If multiple containers in the project disagree on that label
// (mixed-restart edge case), we trust the most common value.
export function detectCompose(): ComposeStatus {
  // Find any running container in either project, then read its label.
  for (const f of getComposeFiles()) {
    if (!existsSync(f.abs)) continue;
    const ids = spawnSync(
      'docker',
      ['compose', '-f', f.file, 'ps', '-q'],
      { cwd: getSubwaveHome(), encoding: 'utf8' },
    );
    if (ids.status !== 0 || ids.stdout.trim() === '') continue;

    // We got containers — now figure out which compose file they were
    // actually launched with.
    const labelFile = detectConfigFileFromContainers(ids.stdout.trim().split('\n'));
    if (labelFile) {
      const match = getComposeFiles().find((c) => c.abs === labelFile);
      if (match) return { env: match.env, file: match, services: listServices(match) };
    }
    // Fallback: trust the file we asked about. Better than reporting "down".
    return { env: f.env, file: f, services: listServices(f) };
  }
  return { env: 'down', file: null, services: {} };
}

// Read com.docker.compose.project.config_files off the first container
// that has it set. Docker stores the absolute path here.
function detectConfigFileFromContainers(containerIds: string[]): string | null {
  for (const id of containerIds) {
    const r = spawnSync(
      'docker',
      ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project.config_files" }}', id],
      { encoding: 'utf8' },
    );
    if (r.status === 0) {
      const v = r.stdout.trim();
      if (v) {
        // Docker can list multiple config files separated by commas if the
        // operator stacked -f flags. Take the first — that's the primary.
        return v.split(',')[0]?.trim() ?? null;
      }
    }
  }
  return null;
}

// `docker compose ps` with --format json. Returns service name → state.
// State strings come straight from docker; common values are "running",
// "exited", "restarting", "created", "paused".
function listServices(f: ComposeFile): Record<string, string> {
  const r = spawnSync(
    'docker',
    ['compose', '-f', f.file, 'ps', '--format', 'json', '--all'],
    { cwd: getSubwaveHome(), encoding: 'utf8' },
  );
  if (r.status !== 0) return {};
  const out: Record<string, string> = {};
  // Docker emits one JSON object per line (newline-delimited JSON), not a
  // JSON array. Be tolerant of either form just in case the format changes.
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

// Image refs (repo:tag) of the project's containers — running or stopped.
// `start` uses this to warn when an already-up stack is a different version
// than the install expects (e.g. a stale locally-tagged build, or a
// :pocket/dev image, masking the release the .env pins).
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

// BYO mode honours the same WEB_PORT / CONTROLLER_PORT / ICECAST_PORT env
// vars the byo-proxy compose file uses, so the operator can override host
// bindings without the CLI losing track of where the services actually live.
function byoPort(name: 'WEB_PORT' | 'CONTROLLER_PORT' | 'ICECAST_PORT' | 'CADDY_PORT', fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// API base URL the controller is reachable on, for the given env. Prod goes
// via Caddy on :7700 (so the same paths the web UI uses work; override the
// host binding with CADDY_PORT in docker/.env). prod-byo hits the host-bound
// controller port directly — the operator's external proxy isn't in the
// picture for CLI-internal calls. Dev hits the controller's mapped port.
export function apiBaseFor(env: ComposeEnv): string {
  if (env === 'prod') return `http://localhost:${byoPort('CADDY_PORT', 7700)}/api`;
  if (env === 'prod-byo') return `http://localhost:${byoPort('CONTROLLER_PORT', 7701)}`;
  return 'http://localhost:7701';
}

// Icecast stream URL for the given env. Prod serves /stream.mp3 through the
// Caddy edge on :7700 (CADDY_PORT-overridable); prod-byo and dev expose
// Icecast directly on its mapped port.
export function streamUrlFor(env: ComposeEnv): string {
  if (env === 'prod') return `http://localhost:${byoPort('CADDY_PORT', 7700)}/stream.mp3`;
  if (env === 'prod-byo') return `http://localhost:${byoPort('ICECAST_PORT', 7702)}/stream.mp3`;
  return 'http://localhost:7702/stream.mp3';
}

// Browser base URL for the web UI, by env. Prod serves the UI through the
// Caddy edge on :7700 (CADDY_PORT-overridable); prod-byo hits the host-bound
// web port; dev runs the Next.js dev server on :7700.
export function webBaseFor(env: ComposeEnv): string {
  if (env === 'prod') return `http://localhost:${byoPort('CADDY_PORT', 7700)}`;
  if (env === 'prod-byo') return `http://localhost:${byoPort('WEB_PORT', 7700)}`;
  return 'http://localhost:7700';
}

// Infer the env from what's on disk under SUBWAVE_HOME. Used by `start` as
// a silent fallback when there's no running stack and no persisted
// preferredEnv to consult.
//
//   - Clone (has docker-compose.dev.yml AND a .git dir) → 'dev'. Both
//     prod compose files also live in a clone, but only the dev file is
//     unique to it (an `init` install never writes docker-compose.dev.yml).
//     The .git check guards against an operator who hand-dropped the dev
//     compose into a standalone home.
//   - Only docker-compose.yml present → 'prod'.
//   - Only docker-compose.byo.yml present → 'prod-byo'.
//   - Anything else (no files, or prod + byo with no dev — the standalone
//     install shape, which is ambiguous between the two prods) → null.
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

// All declared services for a compose file — used when the operator wants
// to pick "any" service even if some aren't running.
export function listDeclaredServices(file: ComposeFile): string[] {
  const r = spawnSync(
    'docker',
    ['compose', '-f', file.file, 'config', '--services'],
    { cwd: getSubwaveHome(), encoding: 'utf8' },
  );
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}
