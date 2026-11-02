// Reads, and on request switches on, "Report Real Path" for SUB/WAVE's own
// Navidrome player rows. Which rows are ours and what the flag means are in
// navidrome-players-policy.ts.
//
// Players are not in the Subsonic API: they live in Navidrome's own REST API
// (the one its web UI uses), reached with a JWT from `POST /auth/login` sent as
// `x-nd-authorization: Bearer …`. A plain (non-admin) account may edit its OWN
// rows there. That API is not a published contract, so every failure here
// degrades to a reading the operator can act on (the Doctor's warning and the
// manual step); none of it throws, and none of it can hold up music.
//
// That login sends the password itself, where Subsonic auth only ever sends a
// salted token, so it is the operator's to allow. With the opt-in off the player
// rows are left alone: the scheduler stands down, and the Doctor and the settings
// card read through passiveRealPathStatus(). Only an operator's press calls
// realPathStatus() directly. The library walk's read of change times
// (file-changes.ts) is a separate login, outside this opt-in. The Subsonic ping is
// not a login, and it goes out under the station's own client name so that no
// read can recreate a `sub-wave-admin` row.
import { config } from '../config.js';
import * as settings from '../settings.js';
import {
  normalizePlayerRow,
  ownPlayers,
  passwordRefusal,
  playerLabel,
  serverKind,
  stateOf,
  type LocalPathSample,
  type NavidromePlayerRow,
  type RealPathStatus,
  type ServerIdentity,
} from './navidrome-players-policy.js';
import { getRandomSongs, localFileState, pingWith, transportDetail } from './subsonic.js';

const TIMEOUT_MS = 5_000;
// Navidrome's list endpoint pages; this covers every realistic player table.
const PAGE = 500;
// Enough to catch a mount that holds little of the library, cheap enough for
// the Doctor: one Subsonic call, then what findLibraryFile() costs per track.
const SAMPLE_SIZE = 5;

class NativeApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly notSent = false) {
    super(message);
  }
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function baseUrl(): string {
  return String(config.navidrome.url || '').replace(/\/+$/, '');
}

export async function nativeFetch(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const { token, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-nd-authorization': `Bearer ${token}` } : {}),
        ...(headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    throw new NativeApiError(timedOut ? 'Navidrome did not answer within 5s' : `could not reach Navidrome: ${transportDetail(err)}`, null);
  }
  if (!res.ok) throw new NativeApiError(`HTTP ${res.status} on ${path.split('?')[0]}`, res.status);
  return res;
}

export async function login(): Promise<string> {
  const refusal = passwordRefusal(baseUrl());
  if (refusal) throw new NativeApiError(refusal, null, true);
  const res = await nativeFetch('/auth/login', {
    method: 'POST',
    // Followed, a 307 would carry the password on, past the check above.
    redirect: 'manual',
    body: JSON.stringify({ username: config.navidrome.user, password: config.navidrome.password }),
  });
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (!body || typeof body.token !== 'string' || !body.token) {
    throw new NativeApiError('no token in the /auth/login answer', null);
  }
  return body.token;
}

async function listPlayers(token: string): Promise<NavidromePlayerRow[]> {
  const res = await nativeFetch(`/api/player?_start=0&_end=${PAGE}`, { token });
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) throw new NativeApiError('the player list is not an array', null);
  return body.map(normalizePlayerRow).filter((r): r is NavidromePlayerRow => r !== null);
}

// Read-modify-write of the whole row, the shape Navidrome's own UI sends. The
// API is unpublished, so this does not lean on what a partial PUT would do.
async function switchOn(token: string, id: string): Promise<void> {
  const res = await nativeFetch(`/api/player/${encodeURIComponent(id)}`, { token });
  const row = (await res.json()) as Record<string, unknown>;
  await nativeFetch(`/api/player/${encodeURIComponent(id)}`, {
    method: 'PUT',
    token,
    body: JSON.stringify({ ...row, reportRealPath: true }),
  });
}

function accessProblem(err: unknown): RealPathStatus['access'] {
  if (!(err instanceof NativeApiError)) return undefined;
  if (err.notSent) return 'not-sent';
  return err.status === 401 || err.status === 403 ? 'refused' : undefined;
}

function ownership() {
  return { clientName: config.navidrome.clientName, user: config.navidrome.user };
}

/** Has the operator opted in to the station keeping the flag on? */
export function realPathOptedIn(): boolean {
  return settings.get().musicSource?.reportRealPath === true;
}

export type NativeServer =
  | { usable: true; server: ServerIdentity }
  | { usable: false; reason: 'not-configured' }
  | { usable: false; reason: 'unreachable'; error: string }
  | { usable: false; reason: 'not-navidrome'; server: ServerIdentity };

/**
 * May Navidrome's own API be asked? The one check before any native call. It asks
 * the Subsonic API which server this is, and a failed ping ends it: the password
 * goes to a server that has just answered as a working music server, never to
 * one that did not.
 */
export async function nativeServer(): Promise<NativeServer> {
  if (!config.navidrome.url || !config.navidrome.user || !config.navidrome.password) {
    return { usable: false, reason: 'not-configured' };
  }
  const ping = await pingWith({
    url: config.navidrome.url,
    user: config.navidrome.user,
    pass: config.navidrome.password,
    client: config.navidrome.clientName,
  });
  if (!ping.ok) return { usable: false, reason: 'unreachable', error: ping.error || 'the Subsonic ping failed' };
  const server: ServerIdentity = {
    type: ping.serverType && ping.serverType !== 'unknown' ? ping.serverType : '',
    version: ping.serverSoftwareVersion ?? null,
  };
  if (serverKind(server.type) === 'other') return { usable: false, reason: 'not-navidrome', server };
  return { usable: true, server };
}

function stoppedAt(native: Exclude<NativeServer, { usable: true }>): RealPathStatus {
  if (native.reason === 'not-navidrome') return { state: 'not-navidrome', players: [], switched: [], server: native.server };
  const reason = native.reason === 'unreachable' ? native.error : 'the music server is not configured';
  return { state: 'unavailable', players: [], switched: [], reason };
}

/**
 * Read the station's player rows; with `enable`, switch on every one still off.
 * A 401/403 stops the pass and reports `refused`, leaving the rows already
 * switched: it is the account's answer, the same for every row. Any other HTTP
 * error is that row's, so the rest still get their turn and the row's failure
 * comes back as `reason`. A connection that dies ends the pass the same way.
 * This logs in, so with the opt-in off only an operator's press may call it;
 * a passive reader goes through passiveRealPathStatus().
 */
export async function realPathStatus({ enable = false }: { enable?: boolean } = {}): Promise<RealPathStatus> {
  const native = await nativeServer();
  if (!native.usable) return stoppedAt(native);
  const { server } = native;
  let token: string;
  let players: NavidromePlayerRow[];
  try {
    token = await login();
    players = ownPlayers(await listPlayers(token), ownership());
  } catch (err) {
    const access = accessProblem(err);
    return {
      state: 'unavailable',
      players: [],
      switched: [],
      server,
      reason: errMessage(err, 'unreachable'),
      ...(access ? { access } : {}),
    };
  }

  const switched: string[] = [];
  const failures: string[] = [];
  let refused = false;
  if (enable) {
    for (const p of players) {
      if (p.reportRealPath) continue;
      try {
        await switchOn(token, p.id);
        p.reportRealPath = true;
        switched.push(p.id);
      } catch (err) {
        const status = err instanceof NativeApiError ? err.status : null;
        refused = status === 401 || status === 403;
        // Named as the operator finds the row; its id stays server-side.
        const why = refused
          ? `HTTP ${status}, this account may not edit its players`
          : status ? `HTTP ${status}` : errMessage(err, 'write failed');
        failures.push(`${playerLabel(p)}: ${why}`);
        if (refused || status === null) break;
      }
    }
  }
  return {
    state: refused ? 'refused' : stateOf(players),
    players,
    switched,
    server,
    ...(failures.length ? { reason: failures.join('; ') } : {}),
  };
}

/**
 * What the Doctor and the card's first paint may know. With the opt-in on that
 * is the rows. With it off it is only which server this is, from the ping, so a
 * non-Navidrome station still gets its one line: no login, no player list.
 */
export async function passiveRealPathStatus(): Promise<RealPathStatus> {
  if (realPathOptedIn()) return realPathStatus();
  const native = await nativeServer();
  if (!native.usable) return stoppedAt(native);
  return { state: 'not-read', players: [], switched: [], server: native.server };
}

/**
 * A few random tracks checked against the MUSIC_LIBRARY_PATH mount, for the
 * Doctor. Null when the sample could not be read. Stateless, as findLibraryFile()
 * is, so a run can't change what the mixer gets next.
 */
export async function sampleLocalPaths(): Promise<LocalPathSample | null> {
  try {
    const songs = await getRandomSongs({ size: SAMPLE_SIZE });
    const sample: LocalPathSample = { sampled: songs.length, missed: [], unproved: [], unread: [] };
    for (const song of songs) {
      const state = localFileState(song);
      if (state === 'none') sample.missed.push(String(song.path));
      if (state === 'unproved') sample.unproved.push(String(song.path));
      if (state === 'unread') sample.unread.push(String(song.path));
    }
    return sample;
  } catch {
    return null;
  }
}

// The automatic pass (scheduler + boot) logs a change of outcome, not every
// hour's identical one: an account that may not edit its rows would otherwise
// write the same refusal 24 times a day.
let lastAutoOutcome = '';

export async function autoEnableRealPath(log: (line: string) => void): Promise<RealPathStatus> {
  const st = await realPathStatus({ enable: true });
  const outcome = st.reason ? `${st.state}:${st.reason}` : st.state;
  if (st.switched.length) {
    const names = st.players.filter(p => st.switched.includes(p.id)).map(p => `${p.client} [${p.userAgent}]`);
    log(`Navidrome: switched Report Real Path on for ${names.join(', ')}`);
  }
  if (st.reason && outcome !== lastAutoOutcome) {
    log(`Navidrome: could not keep Report Real Path on (${st.reason}); see the Doctor for the manual step`);
  }
  lastAutoOutcome = outcome;
  return st;
}

/** Test hook: forget the last automatic outcome. */
export function _resetAutoOutcome(): void {
  lastAutoOutcome = '';
}
