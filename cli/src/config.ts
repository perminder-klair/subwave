// Operator CLI preferences, in ~/.config/subwave/cli.json. Station state belongs
// in the root .env and state/, not here. Loading merges over defaults(), so a
// new key needs no migration.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface CliConfig {
  preferredEnv: 'dev' | 'prod' | 'prod-byo' | null; // used when nothing is up
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
    // A corrupt config must not crash the menu.
    return defaults();
  }
}

export function saveConfig(cfg: CliConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
