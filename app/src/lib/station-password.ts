// SUB/WAVE's own private-station password (#478), as opposed to the HTTP Basic
// Auth "Station login" a reverse proxy may demand (station-credentials.ts). One
// shared password per station unlocks both locks the operator can turn on:
// `privatePlayer` (the player UI) and `listenerAuth` (Icecast on every mount).
// The app rides it on the stream as `?auth=`, like the web player, which also
// lets a Chromecast play it — the receiver cannot send a header.

import type { CredentialStorage } from './credential-vault';

const STORAGE_KEY = 'subwave.stationPasswords.v1';

export interface StationPasswordStore {
  get(base: string): Promise<string | null>;
  set(base: string, password: string): Promise<void>;
  remove(base: string): Promise<void>;
}

export function createStationPasswordStore(storage: CredentialStorage): StationPasswordStore {
  const read = async (): Promise<Record<string, string>> => {
    const raw = await storage.getItemAsync(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Station password store contains invalid data');
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
      ),
    );
  };
  const write = (values: Record<string, string>) =>
    storage.setItemAsync(STORAGE_KEY, JSON.stringify(values));

  return {
    async get(base) {
      return (await read())[base] ?? null;
    },
    async set(base, password) {
      const values = await read();
      values[base] = password;
      await write(values);
    },
    async remove(base) {
      const values = await read();
      if (!(base in values)) return;
      delete values[base];
      await write(values);
    },
  };
}

/** The stream URL with the station password as `?auth=`, or unchanged when
 *  there is none. Icecast forwards the mount's query string to the
 *  controller's /listener-auth, which accepts the token there. */
export function withStreamAuth(url: string, password: string | null | undefined): string {
  if (!password) return url;
  return `${url}${url.includes('?') ? '&' : '?'}auth=${encodeURIComponent(password)}`;
}

/** Which locks /state reports. Absent on an older controller = public. */
export interface StationPrivacy {
  privatePlayer?: boolean;
  listenerAuth?: boolean;
}

export function stationLockRequired(privacy: StationPrivacy | null | undefined): boolean {
  return privacy?.privatePlayer === true || privacy?.listenerAuth === true;
}

/** 'open' = no lock; 'checking' = verifying a saved password; 'prompt' = ask. */
export type GatePhase = 'open' | 'checking' | 'prompt' | 'ok';

/** Whether a station-gated read (lyrics) may go out: always on a public
 *  station, and on a locked one only once its password is proven. Never on
 *  'open' alone: the gate starts there before /state has said which locks
 *  are on, and still shows it for the render in which a lock first appears,
 *  before its check starts. Every refused read spends one of the household's
 *  station-read attempts (20 per 15 minutes). */
export function stationReadsOpen(privacy: StationPrivacy | null | undefined, phase: GatePhase): boolean {
  return !stationLockRequired(privacy) || phase === 'ok';
}

/** `POST /station-auth` outcomes. That route fails CLOSED (401) whenever a lock
 *  is on and the password is wrong; 429 is its rate limit. Anything else —
 *  a network error, a 5xx, an older controller's 404 — says nothing about the
 *  password. */
export type StationAuthResult = 'ok' | 'denied' | 'rate-limited' | 'unavailable';

/** `challenged`: the 401 carried a `WWW-Authenticate` challenge. The
 *  controller's own 401 never does; a reverse proxy refusing the Station login
 *  always does (#1873). That 401 never reached the password check, and read as
 *  'denied' it would make the gate forget a station password that is right. */
export function stationAuthResult(status: number | null, challenged = false): StationAuthResult {
  if (status === 200) return 'ok';
  if (status === 401) return challenged ? 'unavailable' : 'denied';
  if (status === 429) return 'rate-limited';
  return 'unavailable';
}

export interface StoredPasswordVerdict {
  /** 'ok' = play with the stored password; 'prompt' = ask the listener. */
  phase: 'ok' | 'prompt';
  /** A password proven right that is not yet the stored one: store it. */
  save: string | null;
  /** The stored password was rejected: forget it. */
  clearStored: boolean;
}

/** Decide, once per station visit, whether the passwords this device already
 *  holds still open a locked station.
 *
 *  - The stored station password is checked first. Rejected, it is forgotten;
 *    UNVERIFIABLE (offline, rate-limited), it is kept and used, because the
 *    real boundary is server-side (Icecast checks every connect) and a network
 *    blip must not sign the listener out.
 *  - Then the "Station login" password, which is how the docs told app users to
 *    reach a stream-password station before the app had its own prompt. Proven
 *    right, it becomes the stored station password, so those listeners are
 *    never re-asked. Unverified, it is not trusted: it may be a proxy password.
 *  - Otherwise, ask. */
export async function verifyStoredPasswords(opts: {
  stored: string | null;
  login: string | null;
  check: (password: string) => Promise<StationAuthResult>;
}): Promise<StoredPasswordVerdict> {
  let clearStored = false;
  if (opts.stored) {
    const result = await opts.check(opts.stored);
    if (result === 'denied') clearStored = true;
    else return { phase: 'ok', save: null, clearStored: false };
  }
  if (opts.login && opts.login !== opts.stored) {
    if ((await opts.check(opts.login)) === 'ok') {
      return { phase: 'ok', save: opts.login, clearStored: false };
    }
  }
  return { phase: 'prompt', save: null, clearStored };
}
