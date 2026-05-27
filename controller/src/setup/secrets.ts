// Secrets file — state/secrets.env, mode 0600, sourced into process.env on
// controller boot. The first-run wizard writes cloud LLM / TTS API keys here
// when the operator supplies them through the form. Mode 0600 matches the
// posture of state/icecast-secrets.env (root-owned, in-container only readers).
//
// Format is shell-style KEY=value lines (so an operator can hand-edit it
// before boot if they prefer); no quoting/escaping beyond stripping a single
// pair of surrounding quotes.

import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { STATE_DIR } from '../config.js';

const PATH = `${STATE_DIR}/secrets.env`;

// Keys the wizard is allowed to write. Anything else passed in gets ignored —
// defense against the form being abused as a generic env-var setter.
export const SECRET_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ELEVENLABS_API_KEY',
  'SEARCH_API_KEY',
  // Scrobbling. See broadcast/scrobble.ts. Env always wins over settings.json,
  // so a host with these in compose env_file works without ever touching the UI.
  'LASTFM_API_KEY',
  'LASTFM_API_SECRET',
  'LASTFM_SESSION_KEY',
  'LISTENBRAINZ_USER_TOKEN',
];

// Read state/secrets.env and merge into process.env for keys that aren't
// already set there. Real env vars (from .env via compose env_file) always
// win — the secrets file is just a fallback / persistence layer for keys the
// wizard collected.
export async function loadSecretsIntoEnv(): Promise<{ loaded: string[]; skipped: string[] }> {
  const loaded: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(PATH)) return { loaded, skipped };

  const text = await readFile(PATH, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single pair of surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!SECRET_ENV_KEYS.includes(key)) continue;
    if (process.env[key]) {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    loaded.push(key);
  }
  return { loaded, skipped };
}

// Persist a batch of API keys to state/secrets.env. Merges with whatever is
// already there so a wizard re-run that only changes one key doesn't clobber
// the others. Empty values are written through as `KEY=` rather than deleting
// the entry — the next boot then sees an empty string and falls back to env.
export async function saveSecrets(patch: Record<string, string>): Promise<void> {
  const current: Record<string, string> = {};
  if (existsSync(PATH)) {
    for (const rawLine of (await readFile(PATH, 'utf8')).split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      if (SECRET_ENV_KEYS.includes(key)) current[key] = line.slice(eq + 1);
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!SECRET_ENV_KEYS.includes(key)) continue;
    current[key] = value;
    // Take effect immediately for any subsequent AI SDK call this process
    // makes. Restart isn't required for the keys collected via the wizard.
    if (value) process.env[key] = value;
  }
  const body = [
    '# SUB/WAVE secrets — written by the first-run wizard.',
    '# Sourced by the controller on boot. Mode 0600 enforced below.',
    '',
    ...Object.entries(current).map(([k, v]) => `${k}=${envEscape(v)}`),
    '',
  ].join('\n');
  await writeFile(PATH, body);
  await chmod(PATH, 0o600);
}

// Same shape as cli/src/util.ts:envEscape — keep them in sync. We single-quote
// any value that isn't ASCII-alphanumeric-plus-a-few-punct so the reader's
// "strip one pair of surrounding quotes" path takes effect. Strictly speaking
// the controller's loader doesn't interpolate, so this is mostly cosmetic /
// defence-in-depth here; it matters more when the same file ever gets read by
// something that does interpolate.
function envEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@,+\-]*$/.test(value)) return value;
  if (value.includes("'")) {
    throw new Error(
      "Secret value contains a single quote; refuse to persist (no safe quoting in single-quoted .env).",
    );
  }
  return `'${value}'`;
}
