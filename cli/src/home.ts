// SUB/WAVE home resolution.
//
// The "home" is the directory where the operator's install lives —
// compose files at the top, state/ underneath, .env at the root. Standalone
// CLI installs put this at ~/subwave by default; cloned-repo workflows use
// the repo root itself.
//
// Resolution precedence (highest wins):
//   1. --home <path> flag passed to the CLI
//   2. SUBWAVE_HOME environment variable
//   3. ~/.config/subwave/config.json `home` field
//   4. cwd, if it contains a docker-compose.yml (the cloned-repo path)
//   5. ~/subwave, if it exists
//
// If none match, resolveSubwaveHome() returns null and the calling command
// should either prompt the operator to run `subwave init` or surface a
// helpful error. Most lifecycle commands (start/stop/logs/etc.) require a
// resolved home — init is the only one that doesn't.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export const HOME_CONFIG_DIR = resolve(homedir(), '.config', 'subwave');
export const HOME_CONFIG_PATH = resolve(HOME_CONFIG_DIR, 'config.json');
export const DEFAULT_SUBWAVE_HOME = resolve(homedir(), 'subwave');

export interface HomeConfig {
  home?: string;
  // Future fields: lastUpdatedAt, cliVersionAtInit, telemetryOptIn, etc.
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

// Look at process.argv for `--home <path>` or `--home=<path>` and strip it
// out so the rest of the CLI doesn't have to know about it. Returns the
// flag value if present, otherwise null. Mutates argv in place so command
// dispatch sees the cleaned-up arguments.
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

// Looks like a SUB/WAVE home — i.e. has a top-level docker-compose.yml.
// Conservative on purpose: we don't try to confirm it's the right version,
// just that it isn't some unrelated directory.
export function looksLikeHome(dir: string): boolean {
  return existsSync(resolve(dir, 'docker-compose.yml'));
}

export interface ResolveOptions {
  // Explicit override (e.g. from a --home CLI flag). Highest priority.
  override?: string | null;
  // If true, fall through to ~/subwave even if it doesn't exist yet.
  // Used by `subwave init` so it can scaffold there without an error.
  allowMissingDefault?: boolean;
}

export interface ResolvedHome {
  home: string;
  // Where the resolution came from — useful for diagnostics + doctor output.
  source: 'flag' | 'env' | 'config' | 'cwd' | 'default';
}

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

// Convenience: resolve or die. Most lifecycle commands use this — they
// can't do anything useful without a home. Prints a pointer to `subwave init`
// before exiting.
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

// A SUBWAVE_HOME is "clone-mode" when it has the developer-only directories
// (controller/, web/, scripts/) alongside the compose files. The
// standalone-CLI install only has docker-compose.yml + state/ + .env.
// Several commands (start dev, web dev hot-reload) only make sense
// in clone-mode.
export function isCloneMode(home: string): boolean {
  return (
    existsSync(resolve(home, 'controller', 'package.json')) &&
    existsSync(resolve(home, 'web', 'package.json'))
  );
}

export function requireCloneMode(home: string, commandName: string): void {
  if (isCloneMode(home)) return;
  process.stderr.write(
    `\`subwave ${commandName}\` needs the cloned repo (controller/, web/, scripts/).\n` +
    `Current SUBWAVE_HOME=${home} looks like a standalone install.\n` +
    'Clone the repo with `git clone https://github.com/perminder-klair/subwave.git` to use this command.\n',
  );
  process.exit(2);
}
