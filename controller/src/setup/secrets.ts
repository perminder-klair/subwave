// Secrets file — state/secrets.env, mode 0600, sourced into process.env on
// controller boot. The first-run wizard writes cloud LLM / TTS API keys here
// when the operator supplies them through the form. Mode 0600 matches the
// posture of state/icecast-secrets.env (root-owned, in-container only readers).
//
// Format is shell-style KEY=value lines. The file is deliberately hand-editable
// — the header says so and operators do it — which is why reading it goes
// through `dotenv` rather than a bespoke line splitter. The splitter it replaces
// understood only `KEY=value` plus one pair of surrounding quotes, so ordinary
// .env syntax silently produced the WRONG SECRET: `export KEY=…` was skipped
// entirely (key absent → the provider 401s), and a trailing `# note` became part
// of the value. Nothing in that failure points at this file.
//
// `readSecretsFile` is the ONE parse. It used to exist twice — once in
// loadSecretsIntoEnv and once inside saveSecrets' merge — which is the load-path
// / save-path split this codebase treats as a defect everywhere else, and here
// the two must agree by construction: saveSecrets READS THEN REWRITES, so a
// value the merge misreads is a value written back misread.
//
// The reader stays paired with envEscape at the bottom of this file: the writer
// quotes anything outside a conservative safe set precisely so the reader gets
// it back verbatim. Two things dotenv does that the old splitter did not, both
// warned about rather than silently accepted — see readSecretsFile.

import { existsSync } from 'node:fs';
import { chmod, readFile } from 'node:fs/promises';
import { parse as parseDotenv } from 'dotenv';
import { STATE_DIR } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

const PATH = `${STATE_DIR}/secrets.env`;

// Keys the wizard is allowed to write. Anything else passed in gets ignored —
// defense against the form being abused as a generic env-var setter.
export const SECRET_ENV_KEYS = [
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
  // Embeddings. Only needed when the embedding provider uses a different key
  // than chat (e.g. OpenRouter for embeddings, a local proxy for chat) — see
  // embedding.ts embeddingCfg(). Blank → embeddings inherit settings.llm.apiKey.
  'EMBEDDING_API_KEY',
  // Scrobbling. See broadcast/scrobble.ts. Env always wins over settings.json,
  // so a host with these in compose env_file works without ever touching the UI.
  'LASTFM_API_KEY',
  'LASTFM_API_SECRET',
  'LASTFM_SESSION_KEY',
  'LISTENBRAINZ_USER_TOKEN',
  'LISTENBRAINZ_API_URL',
];

// An unquoted value carrying a `#`. dotenv reads that as the start of an inline
// comment and truncates there, which is correct .env semantics and is what makes
// `KEY=sk-abc # my key` work — but it is ALSO how a secret that genuinely
// contains a `#` loses its tail. The old splitter kept the tail, so this is the
// one place the swap could trade a silent wrong value for a different silent
// wrong value. It doesn't: the case is detected and warned, and the fix (quote
// it) is named. The writer never produces this shape — envEscape single-quotes
// anything outside `[A-Za-z0-9_./:@,+\-]`, `#` included — so this can only come
// from a hand edit.
const UNQUOTED_HASH_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?!['"])[^#\r\n]*#/;

export interface SecretsRead {
  values: Record<string, string>;
  warnings: string[];
}

// The single parse of secrets.env. Returns only the keys this module owns, plus
// any warnings worth surfacing — never throws, because a hand-edited secrets
// file must not be able to wedge boot.
export function readSecretsFile(text: string): SecretsRead {
  const warnings: string[] = [];
  let parsed: Record<string, string> = {};
  try {
    parsed = parseDotenv(text);
  } catch (err: any) {
    // dotenv.parse is not documented to throw, but this runs on the boot path
    // for a file the operator edits by hand — an unreadable file costs the
    // stored keys, not the station.
    return { values: {}, warnings: [`secrets.env could not be parsed (${err?.message || err})`] };
  }

  for (const line of text.split('\n')) {
    const m = UNQUOTED_HASH_RE.exec(line);
    if (m && SECRET_ENV_KEYS.includes(m[1])) {
      warnings.push(
        `${m[1]} contains an unquoted "#", so its value was cut short there. ` +
          `If the "#" is part of the secret, wrap the value in single quotes.`,
      );
    }
  }

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!SECRET_ENV_KEYS.includes(key)) continue;
    // dotenv supports multi-line quoted values; envEscape refuses to persist
    // one. Carrying such a value would put the live env and the file out of
    // lockstep and make the NEXT saveSecrets throw on a key the operator never
    // touched, so it is dropped here — loudly, at the point of the edit.
    if (/[\r\n]/.test(value)) {
      warnings.push(`${key} spans multiple lines, which this file cannot store — ignoring it.`);
      continue;
    }
    values[key] = value;
  }
  return { values, warnings };
}

// Read state/secrets.env and merge into process.env for keys that aren't
// already set there. Real env vars (from .env via compose env_file) always
// win — the secrets file is just a fallback / persistence layer for keys the
// wizard collected.
export async function loadSecretsIntoEnv(): Promise<{ loaded: string[]; skipped: string[]; warnings: string[] }> {
  const loaded: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(PATH)) return { loaded, skipped, warnings: [] };

  const { values, warnings } = readSecretsFile(await readFile(PATH, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key]) {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    loaded.push(key);
  }
  return { loaded, skipped, warnings };
}

// Persist a batch of API keys to state/secrets.env. Merges with whatever is
// already there so a wizard re-run that only changes one key doesn't clobber
// the others. Empty values are written through as `KEY=` rather than deleting
// the entry — the next boot then sees an empty string and falls back to env.
export async function saveSecrets(patch: Record<string, string>): Promise<void> {
  // Same reader as the boot path, deliberately: this merge rewrites the whole
  // file, so a value read wrong here is a stored secret destroyed on disk.
  const current: Record<string, string> = existsSync(PATH)
    ? readSecretsFile(await readFile(PATH, 'utf8')).values
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (!SECRET_ENV_KEYS.includes(key)) continue;
    current[key] = value;
  }
  const body = [
    '# SUB/WAVE secrets — written by the first-run wizard.',
    '# Sourced by the controller on boot. Mode 0600 enforced below.',
    '',
    ...Object.entries(current).map(([k, v]) => `${k}=${envEscape(v)}`),
    '',
  ].join('\n');
  // Atomic replace, created 0600 — the temp file never exists with looser
  // permissions, and a crash mid-write can't truncate existing secrets.
  await writeFileAtomic(PATH, body, { mode: 0o600 });
  await chmod(PATH, 0o600);
  // Only now — after the file is safely on disk — mutate the live process env,
  // so any subsequent AI SDK call sees the new key without a restart. Doing this
  // after the write (rather than in the merge loop above) means a value rejected
  // by envEscape (newline/quote) never takes effect in-process while being absent
  // from the file: the live env and disk stay in lockstep.
  for (const [key, value] of Object.entries(patch)) {
    if (!SECRET_ENV_KEYS.includes(key) || !value) continue;
    process.env[key] = value;
  }
}

// Same shape as cli/src/util.ts:envEscape — keep them in sync. We single-quote
// any value that isn't ASCII-alphanumeric-plus-a-few-punct so the reader's
// "strip one pair of surrounding quotes" path takes effect. Strictly speaking
// the controller's loader doesn't interpolate, so this is mostly cosmetic /
// defence-in-depth here; it matters more when the same file ever gets read by
// something that does interpolate.
function envEscape(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('Secret value contains a newline; refuse to persist (would corrupt line-based parser)');
  }
  if (/^[A-Za-z0-9_./:@,+\-]*$/.test(value)) return value;
  if (value.includes("'")) {
    throw new Error(
      "Secret value contains a single quote; refuse to persist (no safe quoting in single-quoted .env).",
    );
  }
  return `'${value}'`;
}
