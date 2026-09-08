// Pure decision logic for Icecast URL-based listener authentication (#478).
// Icecast POSTs listener_add/listener_remove to /listener-auth with `pass`
// (basic auth off the stream URL; one shared password, username ignored) and
// `mount` INCLUDING its query string — the web player rides a `?auth=` token
// there because a browser cannot attach basic auth to an <audio> element.
import { createHash, timingSafeEqual } from 'node:crypto';

// Constant-time compare over fixed-size digests, so length leaks nothing.
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

// Pull the auth token out of a mount string's query, if any.
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

// The web UI's gate, and deliberately NOT listenerAuthDecision: this fails
// CLOSED. Reusing the fail-open version would accept every password whenever
// privatePlayer is on and listenerAuth off.
export function stationAuthDecision(opts: {
  privatePlayer: boolean;
  listenerAuth: boolean;
  password: string;
  candidate?: string;
}): boolean {
  // Neither lock engaged — nothing to unlock, so nothing to reject.
  if (!opts.privatePlayer && !opts.listenerAuth) return true;
  // A lock is on but no password is on file: fail closed.
  if (!opts.password) return false;
  return safeEqual(opts.candidate || '', opts.password);
}

// Where a station password rides on a plain GET (#1575), in precedence order:
// `x-station-auth`, `authorization: Bearer`, then `?auth=` — the query form is
// LAST because it lands in proxy logs, history and Referer; it stays supported
// only because the stream mount has no header. First non-empty wins, and a
// repeated query param (an array) is ignored rather than guessed at.
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
