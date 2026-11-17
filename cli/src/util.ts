// Misc helpers. Kept dependency-free so any module can pull these in.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { requireSubwaveHome } from './home.ts';

// Resolved lazily so `subwave init` (no home yet) and `subwave --version` can
// short-circuit. cli.ts has already folded `--home` into process.env.SUBWAVE_HOME.
let _subwaveHome: string | null = null;
export function getSubwaveHome(): string {
  if (_subwaveHome === null) _subwaveHome = requireSubwaveHome().home;
  return _subwaveHome;
}

// Call these rather than caching at module load; that would force home
// resolution at import time and break `subwave init`.
export function getRootEnv(): string { return resolve(getSubwaveHome(), '.env'); }
export function getRootEnvExample(): string { return resolve(getSubwaveHome(), '.env.example'); }
export function getStateDir(): string { return resolve(getSubwaveHome(), 'state'); }
export function getSetupConfigPath(): string { return resolve(getStateDir(), 'setup-config.json'); }
export function getLegacyControllerEnv(): string { return resolve(getSubwaveHome(), 'controller', '.env'); }

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

// The text after `=` on a .env line, read as docker compose reads it. A quoted
// value ends at its closing quote, so a ` # ` inside it stays and anything after
// it (`"8080"#x`, `"8080" # x`) goes; `\"` is a literal quote inside double
// quotes. An unquoted value is cut at its first ` #` (a space, not a tab, as
// compose does) and trimmed. A trailing CR goes with the whitespace. Compose's
// `${VAR}` interpolation is not done.
export function envValue(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    let out = '';
    for (let i = 1; i < v.length; i++) {
      const c = v[i] as string;
      if (c === q) return out;
      if (q === '"' && c === '\\' && v[i + 1] === '"') { out += '"'; i++; continue; }
      out += c;
    }
    // Unterminated: compose refuses the file. Keep the text as written.
    return v;
  }
  const cut = v.indexOf(' #');
  return (cut === -1 ? v : v.slice(0, cut)).trimEnd();
}

// One key from a .env file, as compose resolves it: the last assignment wins,
// an `export ` prefix is allowed, and CRLF line ends work. parseEnvFile is not
// that: it keeps an inline comment, unquotes a value only when the line ends in
// its quote, and skips `export` and CRLF lines. A value the CLI compares with or
// hands to compose is read through this. undefined when the file or key is
// missing.
export function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let found: string | undefined;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m && m[1] === key) found = envValue(m[2] ?? '');
  }
  return found;
}

// Quote a .env value so docker compose reads it literally. Compose interpolates
// `$VAR` in both unquoted and double-quoted values, so only single quotes are
// safe (#156). There is no escape for `'` inside `'...'`, so a value containing
// one throws and the caller surfaces a validation error.
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
// template), keeping comments and key order. Keys absent from the template are
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

// Read the wizard overlay to pre-fill setup prompts. The controller owns writes.

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
