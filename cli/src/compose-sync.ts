// Compose drift detection + on-demand re-materialisation.
//
// `subwave init` writes the embedded compose files + .env.example into the
// install dir once, and no other command ever rewrites them: `self-update`
// swaps only the binary, `update`/`start` read the on-disk files. So an install
// scaffolded before a service was added (e.g. the `analyzer` service in
// v0.34.0) keeps a compose file that lacks it forever — the root cause of #1043.
//
// This module lets the CLI (a) detect that the on-disk files are behind the
// binary's embedded copies (surfaced as warnings by `update`/`doctor`) and
// (b) rewrite them on explicit demand (`subwave sync`), backing up anything it
// changes. It never touches the live .env (secrets live there); .env.example is
// a pure template, refreshed without a backup so operators can diff it by hand.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COMPOSE_YML,
  COMPOSE_BYO_YML,
  COMPOSE_TTS_HEAVY_GPU_YML,
  COMPOSE_ANALYZER_GPU_YML,
  ENV_EXAMPLE,
} from './assets.ts';
import { loadConfig } from './config.ts';
import { isCloneMode } from './home.ts';

// The deployment shape a standalone install was scaffolded as. Dev/clone
// installs get their compose from git, so they're out of scope here.
export type InstallMode = 'prod' | 'prod-byo';

export interface ExpectedFile {
  name: string; // basename in the install dir
  content: string; // the embedded copy this CLI would write
  // .env.example is a pure template — refreshed without a .bak (no operator data).
  backup: boolean;
}

export type DriftStatus = 'fresh' | 'drifted' | 'missing';

export interface DriftEntry {
  name: string;
  status: DriftStatus;
}

export interface SyncEntry {
  name: string;
  action: 'created' | 'updated' | 'unchanged';
  backup?: string; // basename of the .bak written, when one was
}

// The file-set `subwave init` materialises, resolved from the embedded assets
// for the given mode. Keep in lockstep with init.ts:scaffold().
export function expectedFiles(mode: InstallMode): ExpectedFile[] {
  return [
    {
      name: 'docker-compose.yml',
      content: mode === 'prod-byo' ? COMPOSE_BYO_YML : COMPOSE_YML,
      backup: true,
    },
    { name: 'docker-compose.byo.yml', content: COMPOSE_BYO_YML, backup: true },
    { name: 'docker-compose.tts-heavy-gpu.yml', content: COMPOSE_TTS_HEAVY_GPU_YML, backup: true },
    { name: 'docker-compose.analyzer-gpu.yml', content: COMPOSE_ANALYZER_GPU_YML, backup: true },
    { name: '.env.example', content: ENV_EXAMPLE, backup: false },
  ];
}

// Resolve the deployment shape of a standalone install. preferredEnv (written
// by init/start) is authoritative; otherwise infer from the on-disk
// docker-compose.yml — the prod variant bundles a `caddy:` service, BYO doesn't.
// Returns null for clone/dev installs or when it can't be determined; backups
// make even a wrong guess recoverable.
export function resolveInstallMode(home: string): InstallMode | null {
  if (isCloneMode(home)) return null;
  const pref = loadConfig().preferredEnv;
  if (pref === 'prod' || pref === 'prod-byo') return pref;
  if (pref === 'dev') return null;

  const composePath = resolve(home, 'docker-compose.yml');
  if (!existsSync(composePath)) return null;
  const body = readFileSync(composePath, 'utf8');
  return /^ {2}caddy:/m.test(body) ? 'prod' : 'prod-byo';
}

// Byte-compare each expected file against what's on disk.
export function detectDrift(home: string, mode: InstallMode): DriftEntry[] {
  return expectedFiles(mode).map(({ name, content }) => {
    const path = resolve(home, name);
    if (!existsSync(path)) return { name, status: 'missing' };
    return { name, status: readFileSync(path, 'utf8') === content ? 'fresh' : 'drifted' };
  });
}

export function hasDrift(entries: DriftEntry[]): boolean {
  return entries.some((e) => e.status !== 'fresh');
}

// Re-materialise the drifted/missing files, backing up any existing file that
// changes (except .env.example). Fresh files are left untouched.
export function syncFiles(home: string, mode: InstallMode): SyncEntry[] {
  const stamp = backupStamp();
  const out: SyncEntry[] = [];
  for (const { name, content, backup } of expectedFiles(mode)) {
    const path = resolve(home, name);
    const exists = existsSync(path);
    if (exists && readFileSync(path, 'utf8') === content) {
      out.push({ name, action: 'unchanged' });
      continue;
    }
    let backupName: string | undefined;
    if (exists && backup) {
      backupName = `${name}.bak-${stamp}`;
      writeFileSync(resolve(home, backupName), readFileSync(path));
    }
    writeFileSync(path, content);
    out.push({ name, action: exists ? 'updated' : 'created', backup: backupName });
  }
  return out;
}

// Compact local timestamp for backup filenames, e.g. 20260715-142530.
function backupStamp(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}
