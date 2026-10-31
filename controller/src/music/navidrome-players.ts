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
import { config } from '../config.js';
import {
  normalizePlayerRow,
  ownPlayers,
  serverKind,
  stateOf,
  type NavidromePlayerRow,
  type RealPathStatus,
  type ServerIdentity,
} from './navidrome-players-policy.js';
import { pingWith } from './subsonic.js';

const TIMEOUT_MS = 5_000;
// Navidrome's list endpoint pages; this covers every realistic player table.
const PAGE = 500;

class NativeApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function baseUrl(): string {
  return String(config.navidrome.url || '').replace(/\/+$/, '');
}

async function nativeFetch(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
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
    throw new NativeApiError(timedOut ? 'Navidrome did not answer within 5s' : errMessage(err, 'unreachable'), null);
  }
  if (!res.ok) throw new NativeApiError(`HTTP ${res.status} on ${path.split('?')[0]}`, res.status);
  return res;
}

async function login(): Promise<string> {
  const res = await nativeFetch('/auth/login', {
    method: 'POST',
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

// Read-modify-write of the whole row: Navidrome's PUT replaces the record, so
// sending only the flag would blank the row's other fields.
async function switchOn(token: string, id: string): Promise<void> {
  const res = await nativeFetch(`/api/player/${encodeURIComponent(id)}`, { token });
  const row = (await res.json()) as Record<string, unknown>;
  await nativeFetch(`/api/player/${encodeURIComponent(id)}`, {
    method: 'PUT',
    token,
    body: JSON.stringify({ ...row, reportRealPath: true }),
  });
}

function ownership() {
  return { clientName: config.navidrome.clientName, user: config.navidrome.user };
}

/**
 * Read the station's player rows; with `enable`, switch on every one still off.
 * A row refused mid-way leaves the others switched and reports `refused`.
 */
export async function realPathStatus({ enable = false }: { enable?: boolean } = {}): Promise<RealPathStatus> {
  if (!config.navidrome.url || !config.navidrome.user || !config.navidrome.password) {
    return { state: 'unavailable', players: [], switched: [], reason: 'the music server is not configured' };
  }
  // Ask the Subsonic API which server this is before touching Navidrome's own.
  // A failed ping is not a verdict: the native login below reports the outage.
  const ping = await pingWith({ url: config.navidrome.url, user: config.navidrome.user, pass: config.navidrome.password });
  const server: ServerIdentity | undefined = ping.ok
    ? { type: ping.serverType && ping.serverType !== 'unknown' ? ping.serverType : '', version: ping.serverSoftwareVersion ?? null }
    : undefined;
  if (serverKind(server?.type) === 'other') {
    return { state: 'not-navidrome', players: [], switched: [], server };
  }
  let token: string;
  let players: NavidromePlayerRow[];
  try {
    token = await login();
    players = ownPlayers(await listPlayers(token), ownership());
  } catch (err) {
    return { state: 'unavailable', players: [], switched: [], server, reason: errMessage(err, 'unreachable') };
  }

  const switched: string[] = [];
  if (enable) {
    for (const p of players) {
      if (p.reportRealPath) continue;
      try {
        await switchOn(token, p.id);
        p.reportRealPath = true;
        switched.push(p.id);
      } catch (err) {
        const status = err instanceof NativeApiError ? err.status : null;
        const reason = status === 401 || status === 403
          ? `HTTP ${status}: this account may not edit its players`
          : errMessage(err, 'write failed');
        return { state: 'refused', players, switched, server, reason };
      }
    }
  }
  return { state: stateOf(players), players, switched, server };
}

// The automatic pass (scheduler + boot) logs a change of outcome, not every
// hour's identical one: an account that may not edit its rows would otherwise
// write the same refusal 24 times a day.
let lastAutoOutcome = '';

export async function autoEnableRealPath(log: (line: string) => void): Promise<RealPathStatus> {
  const st = await realPathStatus({ enable: true });
  const outcome = st.state === 'refused' || st.state === 'unavailable' ? `${st.state}:${st.reason}` : st.state;
  if (st.switched.length) {
    const names = st.players.filter(p => st.switched.includes(p.id)).map(p => `${p.client} [${p.userAgent}]`);
    log(`Navidrome: switched Report Real Path on for ${names.join(', ')}`);
  } else if (outcome !== lastAutoOutcome && (st.state === 'refused' || st.state === 'unavailable')) {
    log(`Navidrome: could not keep Report Real Path on (${st.reason}); see the Doctor for the manual step`);
  }
  lastAutoOutcome = outcome;
  return st;
}

/** Test hook: forget the last automatic outcome. */
export function _resetAutoOutcome(): void {
  lastAutoOutcome = '';
}
