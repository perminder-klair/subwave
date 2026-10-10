// The "home" is where the operator's install lives — compose files at the top,
// state/ underneath, .env at the root. A standalone install defaults to
// ~/subwave; a cloned repo uses its own root. See resolveSubwaveHome() for the
// precedence. Every lifecycle command needs a resolved home; `init` is the one
// command that doesn't.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export const HOME_CONFIG_DIR = resolve(homedir(), '.config', 'subwave');
export const HOME_CONFIG_PATH = resolve(HOME_CONFIG_DIR, 'config.json');
export const DEFAULT_SUBWAVE_HOME = resolve(homedir(), 'subwave');

export interface HomeConfig {
  home?: string;
}

export function readHomeConfig(): HomeConfig {
  if (!existsSync(HOME_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(HOME_CONFIG_PATH, 'utf8')) as HomeConfig;
  } catch {
    return {};
  }
}

export function writeHomeConfig(patch: Partial<HomeConfig>): HomeConfig {
  const current = readHomeConfig();
  const next: HomeConfig = { ...current, ...patch };
  mkdirSync(HOME_CONFIG_DIR, { recursive: true });
  writeFileSync(HOME_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// Mutates argv in place, so command dispatch never sees the flag.
export function consumeHomeFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--home') {
      const v = argv[i + 1];
      if (!v) return null;
      argv.splice(i, 2);
      return resolve(v);
    }
    if (a.startsWith('--home=')) {
      const v = a.slice('--home='.length);
      argv.splice(i, 1);
      return resolve(v);
    }
  }
  return null;
}

// Deliberately shallow: this only rules out an unrelated directory, it doesn't
// try to confirm the install's version or shape.
export function looksLikeHome(dir: string): boolean {
  return existsSync(resolve(dir, 'docker-compose.yml'));
}

export interface ResolveOptions {
  override?: string | null; // the --home flag; beats everything
  allowMissingDefault?: boolean; // lets `init` resolve ~/subwave before it exists
}

export interface ResolvedHome {
  home: string;
  source: 'flag' | 'env' | 'config' | 'cwd' | 'default';
}

// Precedence, highest first. null means no install was found.
export function resolveSubwaveHome(opts: ResolveOptions = {}): ResolvedHome | null {
  if (opts.override) {
    return { home: opts.override, source: 'flag' };
  }
  const envHome = process.env.SUBWAVE_HOME?.trim();
  if (envHome) {
    return { home: resolve(envHome), source: 'env' };
  }
  const cfg = readHomeConfig();
  if (cfg.home) {
    return { home: resolve(cfg.home), source: 'config' };
  }
  if (looksLikeHome(process.cwd())) {
    return { home: process.cwd(), source: 'cwd' };
  }
  if (existsSync(DEFAULT_SUBWAVE_HOME) || opts.allowMissingDefault) {
    return { home: DEFAULT_SUBWAVE_HOME, source: 'default' };
  }
  return null;
}

// Resolve or die, for the commands that can't do anything without a home.
export function requireSubwaveHome(opts: ResolveOptions = {}): ResolvedHome {
  const r = resolveSubwaveHome(opts);
  if (r) return r;
  process.stderr.write(
    'No SUB/WAVE install found.\n' +
    `  Looked for SUBWAVE_HOME env, ${HOME_CONFIG_PATH}, ` +
    `cwd with docker-compose.yml, and ${DEFAULT_SUBWAVE_HOME}.\n\n` +
    'Run `subwave init` to scaffold a fresh install.\n',
  );
  process.exit(2);
}

// Clone mode = the developer-only source dirs sit alongside the compose files.
// A standalone install has only docker-compose.yml + state/ + .env, so anything
// that builds or hot-reloads from source is clone-only.
export function isCloneMode(home: string): boolean {
  return (
    existsSync(resolve(home, 'controller', 'package.json')) &&
    existsSync(resolve(home, 'web', 'package.json'))
  );
}
