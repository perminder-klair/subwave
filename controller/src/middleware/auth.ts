import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { clientIp, LIMITER_MAX_KEYS } from './ratelimit.js';
import { BoundedKeyMap } from '../util/bounded-key-map.js';
import { envEnum } from '../util/env.js';

// Admin basic auth. In production ADMIN_USER/ADMIN_PASS are MANDATORY and the
// controller refuses to start without them; in dev the gate is opt-in.
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
export const ADMIN_AUTH_REQUIRED = Boolean(ADMIN_USER && ADMIN_PASS);
const IS_PROD = process.env.NODE_ENV === 'production';
// 10 strikes inside a 15-min window lock that counter for 15 min; a shared NAT
// address must survive a few typos.
const MAX_AUTH_FAILURES = 10;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000;
// The operator's final say over the lock. Env only: a switch inside the console
// is out of reach at the one moment it is needed, and setting this takes the
// same host access that reads ADMIN_PASS. Anything but `off` keeps the lock.
const LOCKOUT_ENABLED = envEnum('ADMIN_LOCKOUT', ['on', 'off'] as const, 'on') === 'on';
// Sent by the web console, which draws its own sign-in. Its 401 must not carry a
// challenge: the browser's native dialog would open over the page, hold the 401
// back from adminFetch, and replay whatever is typed to every held request.
const CONSOLE_HEADER = 'x-subwave-console';

// The strike counter is keyed on WHO is failing, and that is not always the
// address. Behind an edge that hides client addresses (the AIO behind the
// operator's own proxy with no trusted proxies, a tunnel, a proxy that sets no
// X-Forwarded-For) every request shares one clientIp(), so a per-address
// counter is a station-wide one: anyone's ten bad guesses lock the operator
// out, and the operator's console polls, if a success cleared the counter,
// would wipe everyone else's strikes. Two rules close both:
//
//   1. Strikes decay by TIME only — a sliding window per counter. A success
//      never clears a counter: on a shared address it may be someone else's.
//   2. A client that has passed the check carries a DEVICE COOKIE — an HMAC
//      over a random id under a per-process secret — and its strikes count
//      against that id, not the address. The cookie grants nothing (the
//      credentials are still checked on every request, so it is no CSRF
//      handle); it only says "this client has signed in before", which no
//      stranger can mint. A stranger's failures therefore land on the address
//      counter and cannot lock out a signed-in console.
//   3. A strike is a new GUESS, not a request. A browser tab holding a password
//      from before a rotation sends it on every poll and on every query of a
//      page load, and an integration does the same; counted per request, one
//      stale credential locked the station in under a second. Repeating a guess
//      tests nothing new, so the cap on distinct guesses is exactly what it was.
//
// The lock still refuses the RIGHT password while it holds, because a lock that
// admits a correct guess caps nothing — so a client WITHOUT a cookie (a first
// sign-in, any browser after a controller restart, an MCP or API client) still
// shares its address's lock. That residual is the price of keeping the guess
// cap: nothing on a shared address can tell a stranger from a fresh operator
// before the password is compared.
interface Strike { at: number; guess: string }
interface StrikeRecord { failures: Strike[]; lockedUntil: number }
const authStrikes = new BoundedKeyMap<StrikeRecord>({
  maxKeys: LIMITER_MAX_KEYS,
  isLive: (rec, now) => rec.lockedUntil > now || rec.failures.some(s => now - s.at < AUTH_LOCKOUT_MS),
});

const DEVICE_COOKIE = 'subwave_admin_device';
const DEVICE_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
// Per process, never derived from ADMIN_PASS: a stolen cookie must not be an
// offline oracle for the password. A restart invalidates every cookie; the next
// successful request reissues it.
const DEVICE_SECRET = randomBytes(32);

function deviceMac(id: string): string {
  return createHmac('sha256', DEVICE_SECRET).update(id).digest('base64url');
}

// Keyed, so the strike table never holds anything a password can be tested
// against. Prefixed, so it can never equal a device MAC.
function guessMac(authorization: string): string {
  return createHmac('sha256', DEVICE_SECRET).update(`guess:${authorization}`).digest('base64url');
}

// The verified device id, or null for an absent, malformed or forged cookie.
function deviceIdFrom(req): string | null {
  const header = typeof req.headers?.cookie === 'string' ? req.headers.cookie : '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== DEVICE_COOKIE) continue;
    const [id, mac] = part.slice(eq + 1).trim().split('.');
    if (!id || !mac || !/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const want = Buffer.from(deviceMac(id));
    const got = Buffer.from(mac);
    return got.length === want.length && timingSafeEqual(got, want) ? id : null;
  }
  return null;
}

function issueDeviceCookie(req, res) {
  const id = randomBytes(16).toString('base64url');
  const secure = req.secure || String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.append(
    'Set-Cookie',
    `${DEVICE_COOKIE}=${id}.${deviceMac(id)}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
  );
}

// Test seam.
export function resetAdminLockout() {
  authStrikes.clear();
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Called once at startup; exits if a production deploy has no admin credentials.
export function assertAdminConfigured() {
  if (IS_PROD && !ADMIN_AUTH_REQUIRED) {
    console.error(
      '[auth] FATAL: NODE_ENV=production but ADMIN_USER and ADMIN_PASS are not set.\n' +
      '       /debug, /settings and admin endpoints would be publicly readable.\n' +
      '       Set ADMIN_USER and ADMIN_PASS in controller/.env, then rebuild the controller.'
    );
    process.exit(1);
  }
  console.log(`[auth] admin gate ${ADMIN_AUTH_REQUIRED ? 'ENABLED' : 'disabled (set ADMIN_USER+ADMIN_PASS to enable)'}`);
  if (ADMIN_AUTH_REQUIRED && !LOCKOUT_ENABLED) {
    console.warn('[auth] admin lockout DISABLED (ADMIN_LOCKOUT=off): password guesses are not limited');
  }
}

function authenticateAdmin(req, res, next, challenge = true) {
  if (!ADMIN_AUTH_REQUIRED) return next();

  if (!challenge) res.setHeader('Cache-Control', 'no-store');

  // clientIp() is one a client can choose behind a misconfigured edge — defence
  // in depth, not a guarantee. Durable enforcement belongs at the edge.
  const now = Date.now();
  const device = deviceIdFrom(req);
  const key = device ? `device:${device}` : `ip:${clientIp(req)}`;
  const rec = LOCKOUT_ENABLED ? authStrikes.get(key) : undefined;

  if (rec && rec.lockedUntil > now) {
    const retryAfter = Math.ceil((rec.lockedUntil - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    // `code` tells this lock from an admin route's own 429.
    return res.status(429).json({ error: 'too many failed attempts, try again later', code: 'admin_locked' });
  }

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    try {
      // First colon only: per RFC 7617 the password may contain colons.
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const u = sep === -1 ? decoded : decoded.slice(0, sep);
      const p = sep === -1 ? '' : decoded.slice(sep + 1);
      if (safeEqual(u, ADMIN_USER) && safeEqual(p, ADMIN_PASS)) {
        // Deliberately touches no counter — see rule 1 above.
        if (!device) issueDeviceCookie(req, res);
        return next();
      }
    } catch {}
  }

  // Only a presented password is a guess. A request with no Basic header tested
  // nothing, and counting it let any page that probes an admin route unsigned
  // spend a shared address's strikes.
  if (LOCKOUT_ENABLED && header.startsWith('Basic ')) {
    // A lapsed lock starts a fresh window, or the next wrong attempt re-locks
    // immediately and the operator gets one try every 15 minutes.
    const entry: StrikeRecord = rec && rec.lockedUntil === 0 ? rec : { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter(s => now - s.at < AUTH_LOCKOUT_MS);
    // A repeat keeps its original timestamp, so a stale poller's one strike
    // still decays by time like any other (rule 1).
    const guess = guessMac(header);
    if (!entry.failures.some(s => s.guess === guess)) {
      entry.failures.push({ at: now, guess });
      if (entry.failures.length >= MAX_AUTH_FAILURES) {
        entry.lockedUntil = now + AUTH_LOCKOUT_MS;
        entry.failures = [];
      }
    }
    authStrikes.set(key, entry, now);
  }

  if (challenge && !req.headers[CONSOLE_HEADER]) res.setHeader('WWW-Authenticate', 'Basic realm="SUB/WAVE admin"');
  return res.status(401).json({ error: 'admin auth required' });
}

export function requireAdmin(req, res, next) {
  return authenticateAdmin(req, res, next);
}

// The web sign-in form handles the 401 itself. Suppressing the challenge here
// keeps a rejected fetch from opening the browser's native Basic Auth dialog.
export function requireAdminUi(req, res, next) {
  return authenticateAdmin(req, res, next, false);
}
