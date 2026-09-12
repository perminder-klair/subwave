// state/secrets.env — shell-style KEY=value, mode 0600, sourced into process.env
// on boot. The first-run wizard writes cloud LLM / TTS API keys here.
//
// The file is deliberately hand-editable, so reading it goes through `dotenv`,
// never a bespoke splitter: a misread is a wrong SECRET, and that surfaces only
// as a provider 401 pointing nowhere near this file.
//
// `readSecretsFile` is the ONE parse. saveSecrets READS THEN REWRITES the whole
// file, so a value a second parse misread would be destroyed on disk. Reader and
// `envEscape` at the bottom are a designed pair: the writer quotes anything
// outside a conservative safe set so the reader gets it back verbatim.

import { existsSync } from 'node:fs';
import { chmod, readFile } from 'node:fs/promises';
import { parse as parseDotenv } from 'dotenv';
import { STATE_DIR } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

const PATH = `${STATE_DIR}/secrets.env`;

// Keys the wizard may write; anything else is ignored, so the form cannot be
// abused as a generic env-var setter.
export const SECRET_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'REQUESTY_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ELEVENLABS_API_KEY',
  'FISH_API_KEY',
  'SEARCH_API_KEY',
  // Only needed when embeddings use a different provider than chat. Blank →
  // embeddings inherit settings.llm.apiKey.
  'EMBEDDING_API_KEY',
  // Scrobbling (broadcast/scrobble.ts). Env wins over settings.json.
  'LASTFM_API_KEY',
  'LASTFM_API_SECRET',
  'LASTFM_SESSION_KEY',
  'LISTENBRAINZ_USER_TOKEN',
  'LISTENBRAINZ_API_URL',
  // Spotify music source (music/sources/spotify). The client id/secret are the
  // operator's own Developer-app credentials; the refresh token is minted by the
  // admin Connect flow (routes/settings/spotify.ts) and may be ROTATED by
  // Spotify on refresh, which is why the client writes it back here.
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REFRESH_TOKEN',
  // The RECEIVER's refresh token (music/sources/spotify/receiver-auth.ts):
  // minted for Spotify's own desktop client id, so librespot can be re-signed
  // in without the operator whenever its credential cache is gone.
  'SPOTIFY_RECEIVER_REFRESH_TOKEN',
];

// An unquoted value carrying a `#`: dotenv truncates there (correct .env
// semantics), which is also how a secret containing a `#` loses its tail. Warned
// rather than silently accepted. Only a hand edit can produce this shape —
// envEscape single-quotes `#`.
const UNQUOTED_HASH_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?!['"])[^#\r\n]*#/;

export interface SecretsRead {
  values: Record<string, string>;
  warnings: string[];
}

// The single parse of secrets.env. Returns only the keys this module owns plus
// any warnings. Never throws: a hand-edited file must not wedge boot.
export function readSecretsFile(text: string): SecretsRead {
  const warnings: string[] = [];
  let parsed: Record<string, string> = {};
  try {
    parsed = parseDotenv(text);
  } catch (err: any) {
    // dotenv.parse is not documented to throw, but this is the boot path: an
    // unreadable file costs the stored keys, not the station.
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
    // dotenv supports multi-line quoted values; envEscape cannot persist one, so
    // carrying it would make the NEXT saveSecrets throw on an untouched key.
    // Dropped loudly instead.
    if (/[\r\n]/.test(value)) {
      warnings.push(`${key} spans multiple lines, which this file cannot store — ignoring it.`);
      continue;
    }
    values[key] = value;
  }
  return { values, warnings };
}

// Merge into process.env for keys not already set there: real env vars always win.
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
    loadedKeys.add(key);
  }
  return { loaded, skipped, warnings };
}

// Which keys came from THIS file rather than the root .env. A route that lets
// the operator edit a secret needs the distinction: env-managed keys are refused
// (env wins on boot, so a saved value would be shadowed again), file-managed ones
// are editable. Keys saved through saveSecrets join the set too.
const loadedKeys = new Set<string>();
export function loadedSecretKeys(): ReadonlySet<string> {
  return loadedKeys;
}

// Persist a batch of API keys to state/secrets.env. Merges with whatever is
// already there so a wizard re-run that only changes one key doesn't clobber
// the others. Empty values are written through as `KEY=` rather than deleting
// the entry — the next boot then sees an empty string and falls back to env.
export async function saveSecrets(patch: Record<string, string>): Promise<void> {
  // Same reader as the boot path: this rewrites the whole file, so a value read
  // wrong here is a stored secret destroyed on disk.
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
  // Atomic replace at 0600: the temp never exists with looser permissions, and a
  // crash mid-write can't truncate existing secrets.
  await writeFileAtomic(PATH, body, { mode: 0o600 });
  await chmod(PATH, 0o600);
  for (const key of Object.keys(patch)) if (SECRET_ENV_KEYS.includes(key)) loadedKeys.add(key);
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

// Same shape as cli/src/util.ts:envEscape — keep them in sync. Single-quotes any
// value outside `[A-Za-z0-9_./:@,+-]` so the reader gets it back verbatim, and so
// it survives a consumer that does interpolate.
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
