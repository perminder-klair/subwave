// Misc helpers. Kept dependency-free so any module can pull these in.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { requireSubwaveHome } from './home.ts';

// Resolved lazily so `subwave init` (no home yet) and `subwave --version` can
// short-circuit before the resolver runs. cli.ts has already folded any
// `--home` flag into process.env.SUBWAVE_HOME, so there's one source of truth.
let _subwaveHome: string | null = null;
export function getSubwaveHome(): string {
  if (_subwaveHome === null) _subwaveHome = requireSubwaveHome().home;
  return _subwaveHome;
}

// Call these rather than caching their results at module load — that would
// force home resolution at import time and break `subwave init`.
export function getScriptsDir(): string { return resolve(getSubwaveHome(), 'scripts'); }
export function getRootEnv(): string { return resolve(getSubwaveHome(), '.env'); }
export function getRootEnvExample(): string { return resolve(getSubwaveHome(), '.env.example'); }
export function getStateDir(): string { return resolve(getSubwaveHome(), 'state'); }
export function getSetupConfigPath(): string { return resolve(getStateDir(), 'setup-config.json'); }
export function getSecretsEnvPath(): string { return resolve(getStateDir(), 'secrets.env'); }
export function getLegacyControllerEnv(): string { return resolve(getSubwaveHome(), 'controller', '.env'); }
export function getLegacyDockerEnv(): string { return resolve(getSubwaveHome(), 'docker', '.env'); }

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

export function have(bin: string): boolean {
  // We only ship where `which` exists (macOS, Linux, WSL).
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

// Best-effort — false if the platform opener can't be spawned.
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

// Quote a .env value so docker compose reads it literally. Compose interpolates
// `$VAR` in BOTH unquoted and double-quoted values — only single quotes are
// taken as-is, so a password like `pre$word` written raw silently mangles into
// a reference to a nonexistent `$word` (#156). There is no escape for `'` inside
// `'...'` and double quotes can't escape `$` either, so an embedded single quote
// throws and lets the caller surface a validation error up front.
function envEscape(value: string): string {
  // Conservative safe set: nothing here triggers interpolation.
  if (/^[A-Za-z0-9_./:@,+\-]*$/.test(value)) return value;
  if (value.includes("'")) {
    throw new Error(
      "Value contains a single quote, which can't be safely written to a Docker " +
      "Compose .env file (the parser has no escape for ' inside single quotes). " +
      'Use a different character.',
    );
  }
  return `'${value}'`;
}

// Rewrites values in place against the existing file (or the .env.example
// template when there isn't one), so the operator's `.env` keeps its comments
// and key order across repeated wizard runs. Keys absent from the template are
// appended; keys absent from `values` are left alone.
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
    return `${key}=${envEscape(values[key] as string)}`;
  });

  for (const [k, v] of Object.entries(values)) {
    if (!seen.has(k)) out.push(`${k}=${envEscape(v)}`);
  }

  let content = out.join('\n');
  if (!content.endsWith('\n')) content += '\n';
  writeFileSync(path, content);
}

// Wizard overlay helpers. Mirror controller/src/setup/{config,secrets}.ts so the
// CLI and web wizards write the same files in the same shape.

export interface SetupConfig {
  navidrome?: { url?: string; user?: string; pass?: string };
  setupCompletedAt?: string;
}

export function readSetupConfig(): SetupConfig {
  const p = getSetupConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SetupConfig;
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
  const p = getSetupConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileWithRecover(p, JSON.stringify(next, null, 2));
  return next;
}

// A state file the browser wizard (or any container) touched first is uid 0
// mode 0644 — readable from the host but not writable. Recover by chowning the
// tree back through a one-shot Docker container, then retry once.
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
    // Still failing means the chown wasn't the problem (read-only mount, say).
    writeFileSync(path, contents);
  }
}

// Idempotent — chown -R over already-owned files is a no-op.
function chownStateDirToCurrentUser(): boolean {
  if (!have('docker')) return false;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return false; // non-POSIX
  const r = spawnSync(
    'docker',
    ['run', '--rm', '-v', `${getStateDir()}:/state`, 'alpine', 'chown', '-R', `${uid}:${gid}`, '/state'],
    { stdio: 'pipe' },
  );
  return r.status === 0;
}

// Mirrors SECRET_ENV_KEYS in controller/src/setup/secrets.ts. Anything not on
// this list is silently ignored.
export const WIZARD_SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'REQUESTY_API_KEY',
  'ORCAROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ELEVENLABS_API_KEY',
  'FISH_API_KEY',
  'SEARCH_API_KEY',
  'EMBEDDING_API_KEY',
] as const;

// Merges into state/secrets.env (0600), preserving hand-added keys. Same shape
// the controller's saveSecrets() writes, so the next boot picks them up.
export function writeSecretsEnv(patch: Record<string, string>): void {
  const p = getSecretsEnvPath();
  const current: Record<string, string> = {};
  if (existsSync(p)) {
    for (const rawLine of readFileSync(p, 'utf8').split('\n')) {
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
    ...Object.entries(current).map(([k, v]) => `${k}=${envEscape(v)}`),
    '',
  ].join('\n');
  mkdirSync(dirname(p), { recursive: true });
  writeFileWithRecover(p, body);
  try {
    chmodSync(p, 0o600);
  } catch {
    // Non-POSIX filesystem (a Windows host) — non-fatal.
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

// fetch() rejects with an AggregateError-ish shape on connection refused; dig
// out the readable bit so doctor reports don't carry stack traces.
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
