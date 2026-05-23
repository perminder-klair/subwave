// Misc helpers. Kept dependency-free so any module can pull these in.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// Repo root resolved from this file's location. Stable regardless of cwd.
//   cli/src/util.ts → cli/src → cli → <repo root>
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');
// Single root .env (post single-compose refactor) — replaces the old
// docker/.env + controller/.env pair. Three vars are required to boot;
// everything else is collected by the wizard and persisted under state/.
export const ROOT_ENV = resolve(REPO_ROOT, '.env');
export const ROOT_ENV_EXAMPLE = resolve(REPO_ROOT, '.env.example');
export const STATE_DIR = resolve(REPO_ROOT, 'state');

// Wizard-managed overlays under state/. These mirror the browser wizard's
// targets so both flows converge on the same persistence layer.
//   setup-config.json — Navidrome creds + setupCompletedAt timestamp
//   secrets.env       — cloud LLM/TTS API keys (mode 0600)
export const SETUP_CONFIG_PATH = resolve(STATE_DIR, 'setup-config.json');
export const SECRETS_ENV_PATH = resolve(STATE_DIR, 'secrets.env');

// Legacy paths — kept exported so doctor.ts / migration shims can warn about
// them, but no fresh write path targets these anymore.
export const LEGACY_CONTROLLER_ENV = resolve(REPO_ROOT, 'controller', '.env');
export const LEGACY_DOCKER_ENV = resolve(REPO_ROOT, 'docker', '.env');

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

export function have(bin: string): boolean {
  // Plain POSIX `which`. Good enough for the operator CLI; we don't ship
  // anywhere `which` isn't available (macOS, Linux, WSL).
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

// Open a URL in the operator's default browser. Detached and best-effort —
// returns false if the platform opener can't be spawned.
export function openUrl(url: string): boolean {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Parse a .env file into { KEY: VALUE }. Comments and blank lines skipped.
// Values with surrounding quotes (single or double) are unwrapped.
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2] ?? '';
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1] as string] = v;
  }
  return out;
}

// Template-aware .env writer. Preserves comments and key order from the
// existing file (or the .env.example template, if the file doesn't exist
// yet). Keys present in `values` but absent from the template are appended
// at the end. Keys present in the template but not in `values` keep their
// existing value untouched.
//
// Pattern lifted from the legacy scripts/setup.mjs:61–77 — the operator
// expects their `.env` to keep its layout across re-runs of the wizard.
export function writeEnvFile(
  path: string,
  values: Record<string, string>,
  opts: { templateFallback?: string } = {},
): void {
  const templateSource = existsSync(path) ? path : opts.templateFallback;
  const lines = templateSource && existsSync(templateSource)
    ? readFileSync(templateSource, 'utf8').split('\n')
    : [];

  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (!m) return line;
    const key = m[1] as string;
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });

  for (const [k, v] of Object.entries(values)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }

  // Always end with exactly one trailing newline.
  let content = out.join('\n');
  if (!content.endsWith('\n')) content += '\n';
  writeFileSync(path, content);
}

// ─── Wizard overlay helpers (state/setup-config.json + state/secrets.env) ───
// Mirror the controller-side helpers in controller/src/setup/{config,secrets}.ts
// so the CLI wizard and the web wizard write the same files in the same shape.

export interface SetupConfig {
  navidrome?: { url?: string; user?: string; pass?: string };
  setupCompletedAt?: string;
}

export function readSetupConfig(): SetupConfig {
  if (!existsSync(SETUP_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETUP_CONFIG_PATH, 'utf8')) as SetupConfig;
  } catch {
    return {};
  }
}

export function writeSetupConfig(patch: Partial<SetupConfig>): SetupConfig {
  const current = readSetupConfig();
  const next: SetupConfig = {
    ...current,
    ...patch,
    navidrome: { ...(current.navidrome || {}), ...(patch.navidrome || {}) },
  };
  mkdirSync(dirname(SETUP_CONFIG_PATH), { recursive: true });
  writeFileWithRecover(SETUP_CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

// Wrap writeFileSync with auto-recovery for the common case of root-owned
// state files. If the browser wizard ran first (or any Docker container
// touched the file), it'll be owned by uid 0 with mode 0644 — readable from
// the host but not writable. Detect EACCES, chown the whole state tree to
// the current host UID via a one-shot Docker container, retry once. If
// Docker isn't available, surface a clear error with the manual fix.
function writeFileWithRecover(path: string, contents: string): void {
  try {
    writeFileSync(path, contents);
    return;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'EACCES' && err?.code !== 'EPERM') throw err;
    if (!chownStateDirToCurrentUser()) {
      throw new Error(
        `${path} is owned by another user (likely root from a Docker container) and Docker isn't available to fix it. ` +
        `Fix manually: docker run --rm -v "$PWD/state:/state" alpine chown -R $(id -u):$(id -g) /state`,
      );
    }
    // Retry. If it still fails, propagate (the chown didn't help — bigger
    // problem like a read-only mount).
    writeFileSync(path, contents);
  }
}

// Shell out to a one-shot Docker container that chowns the state/ tree to
// the current host UID:GID. Idempotent and safe to call when nothing needs
// fixing — chown -R on already-owned files is a no-op. Returns true on
// success, false if Docker isn't on PATH or the chown failed.
function chownStateDirToCurrentUser(): boolean {
  if (!have('docker')) return false;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return false; // non-POSIX
  const r = spawnSync(
    'docker',
    ['run', '--rm', '-v', `${STATE_DIR}:/state`, 'alpine', 'chown', '-R', `${uid}:${gid}`, '/state'],
    { stdio: 'pipe' },
  );
  return r.status === 0;
}

// Keys the wizard is allowed to write to state/secrets.env. Mirrors
// controller/src/setup/secrets.ts SECRET_ENV_KEYS — anything else passed
// in gets silently ignored.
export const WIZARD_SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ELEVENLABS_API_KEY',
  'SEARCH_API_KEY',
] as const;

// Merge a batch of API keys into state/secrets.env (mode 0600), preserving
// any keys the operator added by hand. Same shape the controller's
// saveSecrets() writes, so the next controller boot picks them up.
export function writeSecretsEnv(patch: Record<string, string>): void {
  const current: Record<string, string> = {};
  if (existsSync(SECRETS_ENV_PATH)) {
    for (const rawLine of readFileSync(SECRETS_ENV_PATH, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      if ((WIZARD_SECRET_KEYS as readonly string[]).includes(key)) {
        current[key] = line.slice(eq + 1);
      }
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!(WIZARD_SECRET_KEYS as readonly string[]).includes(key)) continue;
    current[key] = value;
  }
  const body = [
    '# SUB/WAVE secrets — written by the install wizard.',
    '# Sourced by the controller on boot. Mode 0600 enforced below.',
    '',
    ...Object.entries(current).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');
  mkdirSync(dirname(SECRETS_ENV_PATH), { recursive: true });
  writeFileWithRecover(SECRETS_ENV_PATH, body);
  try {
    chmodSync(SECRETS_ENV_PATH, 0o600);
  } catch {
    // chmod may fail on non-POSIX filesystems (e.g. Windows host) — non-fatal.
  }
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatRelative(date: Date | number | string): string {
  const t = typeof date === 'number' ? date : new Date(date).getTime();
  const delta = Date.now() - t;
  if (Number.isNaN(delta)) return '?';
  if (delta < 0) return 'in the future';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// Resolve a fetch failure into a short, human-readable reason. fetch() rejects
// with an AggregateError-ish shape on connection refused; pull out just the
// readable bit so doctor reports don't have stack traces in them.
export function fetchErrorReason(e: unknown): string {
  if (!e) return 'unknown';
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return cause.code;
    if (cause?.message) return cause.message;
    return e.message;
  }
  return String(e);
}
