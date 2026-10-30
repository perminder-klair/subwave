// Both privacy locks share the stored password token. Audio elements cannot send Basic auth, so
// stream URLs include auth=; clear the token only on the station's own refusal.
const KEY = 'subwave-station-auth';

export function getStationAuthToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setStationAuthToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    // Private-mode storage failures just mean re-prompting next visit.
  }
}

export function clearStationAuthToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// No-op when no token is stored (the common public-station case). Player URLs
// already carry a ?t= cache-buster, but handle both shapes.
export function withStreamAuth(url: string): string {
  const token = getStationAuthToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
}

// POST /station-auth outcomes, the web twin of app/src/lib/station-password.ts: no package here
// imports another, so the rules are mirrored, and a change to them goes in both. That route fails
// CLOSED (401) whenever a lock is on and the password is wrong; 429 is its rate limit. Anything
// else says nothing about the password.
export type StationAuthResult = 'ok' | 'denied' | 'rate-limited' | 'unavailable';

export interface StationAuthReply {
  /** The response carried a `WWW-Authenticate` challenge. Unreadable cross-origin, where the body
   *  still tells the controller from a proxy. */
  challenged?: boolean;
  /** The 200's or 401's body, parsed as JSON; absent when it was not JSON. */
  body?: unknown;
}

// A 200 is 'ok' and a 401 is 'denied' only when the controller sent it: its body is its own
// `{ ok: true }` or `{ ok: false }`, and its 401 carries no challenge. A forward-auth proxy's login
// page answers 200 and its refusal 401, and neither request reached the password check.
export function stationAuthResult(status: number | null, reply: StationAuthReply = {}): StationAuthResult {
  if (status === 200) return okField(reply.body) === true ? 'ok' : 'unavailable';
  if (status === 401) return !reply.challenged && okField(reply.body) === false ? 'denied' : 'unavailable';
  if (status === 429) return 'rate-limited';
  return 'unavailable';
}

function okField(body: unknown): unknown {
  return body && typeof body === 'object' ? (body as { ok?: unknown }).ok : undefined;
}

// The route's own window: the controller never asks for longer, so a longer wait is something
// else's.
export const RATE_LIMIT_MAX_WAIT_MS = 15 * 60_000;

// When a 429's Retry-After says to ask again, or 0 when it gives no count of seconds.
export function rateLimitedUntil(retryAfter: string | null, now: number): number {
  const sec = Number(retryAfter);
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return now + Math.min(sec * 1000, RATE_LIMIT_MAX_WAIT_MS);
}

export interface StoredPasswordVerdict {
  /** 'ok' = open the gate with the stored password; 'prompt' = ask the listener. */
  phase: 'ok' | 'prompt';
  /** The stored password was refused: forget it. */
  clearStored: boolean;
}

// The visit check. Only the station's own refusal forgets a password. One it can't verify is kept
// and used, as the app plays with it: the gate hides a face built from public reads, while Icecast
// checks ?auth= on every connect and the gated reads check their header, so opening it gives away
// nothing, and a blip or a full rate-limit bucket must not sign a listener out.
export function storedPasswordVerdict(result: StationAuthResult): StoredPasswordVerdict {
  return result === 'denied' ? { phase: 'prompt', clearStored: true } : { phase: 'ok', clearStored: false };
}

const FAILURE_COPY: Record<Exclude<StationAuthResult, 'ok'>, string> = {
  denied: 'That password was not accepted.',
  'rate-limited': 'Too many attempts. Wait a few minutes, then try again.',
  unavailable: 'Could not reach the station. Check your connection and try again.',
};

function waitCopy(ms: number): string {
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec} ${sec === 1 ? 'second' : 'seconds'}`;
  const min = Math.ceil(sec / 60);
  return `${min} ${min === 1 ? 'minute' : 'minutes'}`;
}

export function stationAuthFailureCopy(
  result: Exclude<StationAuthResult, 'ok'>,
  retryAt: number,
  now: number,
): string {
  if (result === 'rate-limited' && retryAt > now) {
    return `Too many attempts. Try again in ${waitCopy(retryAt - now)}.`;
  }
  return FAILURE_COPY[result];
}

export interface StationAuthCheck {
  result: StationAuthResult;
  /** When a 429 said to ask again; 0 when none did. */
  retryAt: number;
}

export const STATION_AUTH_TIMEOUT_MS = 8000;

// Use fail-closed /station-auth. /listener-auth fails open when stream auth is disabled and would
// let a private player accept any password. One deadline covers the headers and the body, since
// aborting a fetch errors its body read too. AbortSignal.timeout is missing on older Safari.
export async function checkStationAuth(apiBase: string, password: string): Promise<StationAuthCheck> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STATION_AUTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}/station-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: ctrl.signal,
    });
    const retryAt = res.status === 429 ? rateLimitedUntil(res.headers.get('Retry-After'), Date.now()) : 0;
    const result = stationAuthResult(res.status, {
      challenged: res.headers.has('www-authenticate'),
      // Only these bodies are read: they say who answered. One that is not JSON lands in the catch.
      body: res.status === 200 || res.status === 401 ? await res.json() : undefined,
    });
    return { result, retryAt };
  } catch {
    return { result: stationAuthResult(null), retryAt: 0 };
  } finally {
    clearTimeout(timer);
  }
}
