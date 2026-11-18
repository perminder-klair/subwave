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

// One assignment in a .env file, read the way docker compose reads it (checked
// against `docker compose config`): an `export ` prefix and CRLF line ends are
// allowed, and the last assignment of a key wins.
// - A quoted value ends at its closing quote, which may sit on a later line, so
//   the lines between belong to the value and are never assignments of their
//   own. Anything after the closing quote (`"8080"#x`, `"8080" # x`) goes.
// - In either quote a backslash escapes the next character when finding the
//   closing quote, so `'abc\'` does not close there and runs on to the next `'`,
//   on a later line if need be (compose v5). Inside single quotes nothing is
//   expanded, except that `\'` reads as `'`; every other backslash stays as
//   written. Inside double quotes `\\`, `\"`, `\$`, `\n`, `\r` and `\t` are
//   escapes; any other backslash stays as written.
// - An unquoted value is cut at its first ` #` (a space, not a tab) and trimmed.
// - Outside single quotes, `$$` is a literal `$`, and `$VAR`, `${VAR}`,
//   `${VAR:-x}`, `${VAR-x}`, `${VAR:+x}`, `${VAR+x}` expand from the shell
//   environment first, then from the assignments above it in the file.
//   (`${VAR:?}` and nested `${A:-${B}}` are not handled; compose refuses an
//   unset `:?` anyway.)
// `line` is the index of the assignment's first line and `lines` how many lines
// it spans; `raw` is its text after `=`, before any of the above.
export interface EnvAssignment {
  key: string;
  value: string;
  raw: string;
  line: number;
  lines: number;
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function envAssignments(
  text: string,
  shell: (name: string) => string | undefined = (n) => process.env[n],
): EnvAssignment[] {
  const crlf = text.split('\n');
  const lines = crlf.map((l) => l.replace(/\r$/, ''));
  const out: EnvAssignment[] = [];
  const seen = new Map<string, string>();
  const lookup = (name: string) => shell(name) ?? seen.get(name);

  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] as string).match(ENV_LINE);
    if (!m) continue;
    const key = m[1] as string;
    let raw = m[2] ?? '';
    const start = i;
    const q = raw.trimStart()[0];
    let value: string;
    if (q === '"' || q === "'") {
      // Pull in following lines until the quote closes. Each added line is
      // scanned once, from where the last scan stopped, so an unterminated quote
      // at the top of a long file costs one pass, not one pass per line.
      const parts = [raw.trimStart()];
      const scan = { escaped: false };
      let at = closeIn(parts[0] as string, q, 1, scan);
      let offset = 0;
      while (at === -1 && i + 1 < lines.length) {
        offset += (parts[parts.length - 1] as string).length;
        // A CR inside a quoted value is part of it, as compose keeps it.
        const more = `${(crlf[i] as string).endsWith('\r') ? '\r' : ''}\n${lines[i + 1] as string}`;
        parts.push(more);
        i++;
        at = closeIn(more, q, 0, scan);
      }
      const body = parts.join('');
      raw += parts.slice(1).join('');
      const close = at === -1 ? -1 : offset + at;
      if (close === -1) {
        // Unterminated: compose refuses the file. Keep the text as written.
        value = body.trimEnd();
      } else {
        const inner = body.slice(1, close);
        value = q === "'" ? inner.replaceAll("\\'", "'") : expand(inner, lookup, true);
      }
    } else {
      const v = raw.trim();
      const cut = v.indexOf(' #');
      value = expand((cut === -1 ? v : v.slice(0, cut)).trimEnd(), lookup, false);
    }
    seen.set(key, value);
    out.push({ key, value, raw, line: start, lines: i - start + 1 });
  }
  return out;
}

// Index in `chunk`, from `from`, of the quote that closes a quoted value, or -1.
// In either quote a backslash escapes the next character, as compose scans it,
// which may be the first of the next chunk, so `scan.escaped` carries it over.
function closeIn(chunk: string, q: string, from: number, scan: { escaped: boolean }): number {
  for (let i = from; i < chunk.length; i++) {
    if (scan.escaped) { scan.escaped = false; continue; }
    if (chunk[i] === '\\') { scan.escaped = true; continue; }
    if (chunk[i] === q) return i;
  }
  return -1;
}

const ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', $: '$', n: '\n', r: '\r', t: '\t' };

function expand(v: string, lookup: (name: string) => string | undefined, dq: boolean): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as string;
    if (dq && c === '\\' && i + 1 < v.length) {
      const e = ESCAPES[v[i + 1] as string];
      if (e !== undefined) { out += e; i++; continue; }
      out += c;
      continue;
    }
    if (c !== '$') { out += c; continue; }
    const next = v[i + 1];
    if (next === '$') { out += '$'; i++; continue; }
    if (next === '{') {
      const end = v.indexOf('}', i + 2);
      if (end === -1) { out += c; continue; }
      const m = v.slice(i + 2, end).match(/^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])(.*))?$/s);
      if (!m) { out += v.slice(i, end + 1); i = end; continue; }
      const val = lookup(m[1] as string);
      const op = m[2];
      const arg = m[3] ?? '';
      if (op === ':-') out += val ? val : arg;
      else if (op === '-') out += val ?? arg;
      else if (op === ':+') out += val ? arg : '';
      else if (op === '+') out += val !== undefined ? arg : '';
      else out += val ?? '';
      i = end;
      continue;
    }
    const name = v.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (name) { out += lookup(name[0]) ?? ''; i += name[0].length; continue; }
    out += c;
  }
  return out;
}

// One key from a .env file, as compose resolves it (see envAssignments).
// parseEnvFile is not that: it keeps an inline comment, unquotes a value only
// when the line ends in its quote, skips `export` and CRLF lines, and reads a
// line inside a multi-line value as an assignment. A value the CLI compares
// with or hands to compose is read through this. undefined when the file or key
// is missing.
export function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return envAssignments(readFileSync(path, 'utf8')).filter((a) => a.key === key).pop()?.value;
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
