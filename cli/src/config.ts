// Operator CLI preferences. Persisted to ~/.config/subwave/cli.json so the
// next session remembers things like the last-chosen env when both compose
// files are present. Tiny by design — most state lives in controller/.env
// and state/settings.json, not here.
//
// Pattern: load defaults() merged with whatever's on disk. New keys added
// to defaults() are automatically present in old configs without migration.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface CliConfig {
  // Preferred env when multiple compose files exist and none is up.
  preferredEnv: 'dev' | 'prod' | 'prod-byo' | null;
  // Last apiBase the operator manually overrode (rare, keep around).
  apiBaseOverride: string | null;
}

function defaults(): CliConfig {
  return {
    preferredEnv: null,
    apiBaseOverride: null,
  };
}

const CONFIG_PATH = resolve(
  process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'),
  'subwave',
  'cli.json',
);

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) return defaults();
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return { ...defaults(), ...parsed };
  } catch {
    // Corrupt config falls back to defaults rather than crashing the menu.
    return defaults();
  }
}

export function saveConfig(cfg: CliConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
