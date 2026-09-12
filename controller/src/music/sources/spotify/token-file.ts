// The librespot login hand-off: `state/spotify/token` holds a CURRENT Spotify
// access token (streaming scope) that docker/spotify/librespot-run.sh passes as
// `--access-token` on its FIRST login. librespot then caches reusable
// credentials under state/spotify/cache and never reads this file again, so
// the token's one-hour life is irrelevant after that first boot — but the
// controller keeps it fresh anyway (every refresh rewrites it), because a
// wiped cache must be able to log in again without an operator round trip.
//
// Mode 0600 and atomic, like state/secrets.env; the file is a credential.

import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from '../../../config.js';
import { writeFileAtomic } from '../../../util/atomic-file.js';

export const SPOTIFY_STATE_DIR = path.join(STATE_DIR, 'spotify');
export const LIBRESPOT_TOKEN_PATH = path.join(SPOTIFY_STATE_DIR, 'token');
export const LIBRESPOT_CACHE_DIR = path.join(SPOTIFY_STATE_DIR, 'cache');
// Written by librespot-run.sh at every launch: the Spotify Connect name the
// RUNNING receiver registered with. The controller resolves the device by this,
// never by the settings alone — the handoff file (and the station name before
// it) can change while the receiver keeps the name it booted with, which is how
// the first real run ended up with "receiver not found" on every play.
export const LIBRESPOT_DEVICE_NAME_PATH = path.join(SPOTIFY_STATE_DIR, 'device-name');

let deviceNameMemo: { at: number; value: string | null } | null = null;
export function readReceiverDeviceName(now: number = Date.now()): string | null {
  if (deviceNameMemo && now - deviceNameMemo.at < 5_000) return deviceNameMemo.value;
  let value: string | null = null;
  try {
    const v = readFileSync(LIBRESPOT_DEVICE_NAME_PATH, 'utf8').split('\n')[0].trim();
    value = v || null;
  } catch {
    value = null;
  }
  deviceNameMemo = { at: now, value };
  return value;
}

export async function writeLibrespotToken(accessToken: string, expiresAt: number): Promise<void> {
  if (!existsSync(SPOTIFY_STATE_DIR)) mkdirSync(SPOTIFY_STATE_DIR, { recursive: true, mode: 0o700 });
  // Two lines: the token, then its expiry (ms epoch) so the wrapper can refuse
  // a stale one and wait for a fresh write rather than fail the login.
  await writeFileAtomic(LIBRESPOT_TOKEN_PATH, `${accessToken}\n${Math.floor(expiresAt)}\n`, { mode: 0o600 });
  try { await chmod(LIBRESPOT_TOKEN_PATH, 0o600); } catch { /* best effort on non-POSIX mounts */ }
}

export async function readLibrespotToken(): Promise<{ accessToken: string; expiresAt: number } | null> {
  try {
    const [tok, exp] = (await readFile(LIBRESPOT_TOKEN_PATH, 'utf8')).split('\n');
    if (!tok) return null;
    return { accessToken: tok.trim(), expiresAt: Number(exp) || 0 };
  } catch {
    return null;
  }
}
