// Compose drift detection + on-demand re-materialisation. Only `init` writes the
// compose files and nothing rewrites them afterwards, so an install can keep a
// compose file missing a later service forever (#1043). Detection feeds warnings
// in `update`/`doctor`; rewriting happens only on explicit `subwave sync`, with
// backups. The live .env is never touched (secrets live there).

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

// Standalone shapes only — a clone gets its compose from git.
export type InstallMode = 'prod' | 'prod-byo';

export interface ExpectedFile {
  name: string; // basename in the install dir
  content: string; // the embedded copy this CLI would write
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

// Keep in lockstep with init.ts:scaffold().
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

// preferredEnv is authoritative; failing that, only the bundled-proxy variant
// carries a `caddy:` service. A wrong guess is recoverable: sync backs up first.
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

// Backs up every file it overwrites except .env.example, a pure template.
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
