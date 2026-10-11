// Icecast posts listener_add/listener_remove with pass and the mount query (#478).
// Username is ignored; browser audio uses ?auth= because it cannot send Basic headers.
import { createHash, timingSafeEqual } from 'node:crypto';

// Constant-time compare over fixed-size digests, so length leaks nothing.
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export function mountAuthToken(mount: string): string {
  const q = mount.indexOf('?');
  if (q === -1) return '';
  try {
    return new URLSearchParams(mount.slice(q + 1)).get('auth') || '';
  } catch {
    return '';
  }
}

export function listenerAuthDecision(opts: {
  enabled: boolean;
  password: string;
  action?: string;
  pass?: string;
  mount?: string;
}): boolean {
  // Disconnect bookkeeping is never denied.
  if (opts.action === 'listener_remove') return true;
  // Fails OPEN when auth is off: covers the window where the setting is off but
  // icecast.xml still carries the auth blocks.
  if (!opts.enabled) return true;
  // Enabled with no password on file is a broken state: fail closed.
  if (!opts.password) return false;
  if (safeEqual(opts.pass || '', opts.password)) return true;
  return safeEqual(mountAuthToken(opts.mount || ''), opts.password);
}

// Icecast calls POST /listener-auth over the private network with no
// forwarding headers; every edge in the documented topologies (Caddy, nginx,
// Traefik, Cloudflare) adds at least one. A forwarded call came through the
// public route table, so it is not Icecast — whatever path variant got it past
// the edge's deny rule. LISTENER_AUTH_URL must therefore point straight at the
// controller, never through a proxy.
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'via',
] as const;

export function forwardedByProxy(headers: Record<string, unknown> | undefined): boolean {
  if (!headers) return false;
  return FORWARDING_HEADERS.some((h) => headers[h] !== undefined);
}

// Whether either privacy lock is on. Read by stationAuthDecision and by
// requireStationAuth's throttle, which must stay off on a public station.
export function stationLockEngaged(opts: { privatePlayer: boolean; listenerAuth: boolean }): boolean {
  return opts.privatePlayer || opts.listenerAuth;
}

// The UI gate fails closed. listenerAuthDecision fails open when stream auth
// is off, so it cannot protect privatePlayer independently.
export function stationAuthDecision(opts: {
  privatePlayer: boolean;
  listenerAuth: boolean;
  password: string;
  candidate?: string;
}): boolean {
  // Neither lock engaged — nothing to unlock, so nothing to reject.
  if (!stationLockEngaged(opts)) return true;
  // A lock is on but no password is on file: fail closed.
  if (!opts.password) return false;
  return safeEqual(opts.candidate || '', opts.password);
}

// Prefer x-station-auth, then Bearer, then ?auth= (#1575). Query tokens can
// leak into logs/history/Referer but remain necessary for headerless stream clients.
// First nonempty wins; ignore repeated query arrays.
function firstString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function stationAuthCandidate(src: {
  headerToken?: unknown;
  authorization?: unknown;
  query?: unknown;
}): string {
  const header = firstString(src.headerToken).trim();
  if (header) return header;
  const auth = firstString(src.authorization).trim();
  if (/^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, '').trim();
    if (token) return token;
  }
  return firstString(src.query).trim();
}
