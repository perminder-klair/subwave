import { timingSafeEqual } from 'node:crypto';
import { clientIp } from './ratelimit.js';

// Admin basic auth. In production ADMIN_USER/ADMIN_PASS are MANDATORY and the
// controller refuses to start without them; in dev the gate is opt-in.
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
export const ADMIN_AUTH_REQUIRED = Boolean(ADMIN_USER && ADMIN_PASS);
const IS_PROD = process.env.NODE_ENV === 'production';
// 10 strikes before a 15-min lockout; a shared NAT address must survive a few typos.
const MAX_AUTH_FAILURES = 10;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000;
const authAttempts = new Map<string, { failures: number; lockedUntil: number }>();

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
}

export function requireAdmin(req, res, next) {
  if (!ADMIN_AUTH_REQUIRED) return next();

  // Keys on clientIp(), which a client can choose behind a misconfigured edge —
  // defence in depth, not a guarantee. Durable enforcement belongs at the edge.
  const ip = clientIp(req);
  const now = Date.now();
  const rec = authAttempts.get(ip);

  // Clear the counter once a lockout elapses, or the next wrong attempt re-locks
  // immediately and the operator gets one try every 15 minutes.
  if (rec && rec.lockedUntil > 0 && rec.lockedUntil <= now) {
    rec.failures = 0;
    rec.lockedUntil = 0;
  }

  if (rec && rec.lockedUntil > now) {
    const retryAfter = Math.ceil((rec.lockedUntil - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'too many failed attempts, try again later' });
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
        if (rec) authAttempts.delete(ip);
        return next();
      }
    } catch {}
  }

  const entry = rec || { failures: 0, lockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= MAX_AUTH_FAILURES) {
    entry.lockedUntil = now + AUTH_LOCKOUT_MS;
  }
  authAttempts.set(ip, entry);

  if (authAttempts.size > 500) {
    for (const [k, v] of authAttempts) {
      if (v.lockedUntil < now && now - v.lockedUntil > AUTH_LOCKOUT_MS) authAttempts.delete(k);
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="SUB/WAVE admin"');
  return res.status(401).json({ error: 'admin auth required' });
}
