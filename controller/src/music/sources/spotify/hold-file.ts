// The rate-limit hold, on disk.
//
// `SpotifyClient.limitedUntil` is the gate every caller reads before spending a
// request, and it lived only in memory — so a controller restart forgot it. That
// is the worst possible moment to forget: a restart is exactly when the pool has
// to be rebuilt, so the station came back up and walked the whole catalogue
// straight into a window Spotify had already told us to sit out, earning a
// longer one. Docker restart policies and `up -d --build` make that a loop.
//
// A hold is not a credential, so no 0600 — and like the artist-genre cache it is
// deliberately absent from routes/backup.ts: restoring a stale hold onto another
// machine would silence a station for no reason.
//
// Never throws. A hold that cannot be read is a hold we do not have, which is
// the same position the code was in before this file existed; a hold that
// cannot be written costs us the next restart, not this session.

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../../../util/atomic-file.js';
import { SPOTIFY_STATE_DIR } from './token-file.js';

export const SPOTIFY_HOLD_PATH = path.join(SPOTIFY_STATE_DIR, 'rate-limit.json');

// Which of Spotify's two refusals we are sitting out. They are NOT the same
// thing and must not be reported as one: `rate-limit` is the rolling 30-second
// window and clears in seconds, while `quota` is the developer account's budget
// — shared across every app on the account since July 2026 — and clears on
// Spotify's schedule, not ours.
export type SpotifyHoldKind = 'rate-limit' | 'quota';

export interface SpotifyHold {
  until: number;          // ms epoch
  kind: SpotifyHoldKind;
  endpoint?: string;      // what earned it, for the operator
  at: number;             // when it was recorded
}

export function readHold(file = SPOTIFY_HOLD_PATH, now = Date.now()): SpotifyHold | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const until = Number(raw?.until);
    if (!Number.isFinite(until) || until <= now) return null; // expired, or junk
    return {
      until,
      kind: raw?.kind === 'quota' ? 'quota' : 'rate-limit',
      endpoint: typeof raw?.endpoint === 'string' ? raw.endpoint : undefined,
      at: Number.isFinite(Number(raw?.at)) ? Number(raw.at) : now,
    };
  } catch {
    return null;
  }
}

export function writeHold(hold: SpotifyHold, file = SPOTIFY_HOLD_PATH): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    void writeFileAtomic(file, JSON.stringify(hold)).catch(() => {});
  } catch { /* a hold that cannot be written costs the next restart, not this run */ }
}

// Forget the hold. The operator's escape hatch, and the client's own answer to
// a restored hold it does not believe. A missing file is success, not an error.
export function clearHold(file = SPOTIFY_HOLD_PATH): void {
  try {
    rmSync(file, { force: true });
  } catch { /* nothing to clear, or nothing we can do about it */ }
}
