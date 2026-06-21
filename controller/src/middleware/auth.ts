import { timingSafeEqual } from 'node:crypto';

// Admin basic auth. In production (NODE_ENV=production) ADMIN_USER and
// ADMIN_PASS are MANDATORY — the controller refuses to start without them,
// because /debug, /settings, and the jingle/tagger endpoints expose enough
// internals (queue, recent LLM calls, library stats, hostnames) that a
// public deploy without auth is effectively an open admin console. In dev
// the gate stays opt-in so local iteration is frictionless.
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
export const ADMIN_AUTH_REQUIRED = Boolean(ADMIN_USER && ADMIN_PASS);
const IS_PROD = process.env.NODE_ENV === 'production';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Called once at startup. Exits the process if a production deploy is missing
// admin credentials, then logs the resolved gate state.
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
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    try {
      const [u, p] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      if (safeEqual(u, ADMIN_USER) && safeEqual(p, ADMIN_PASS)) return next();
    } catch {}
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="SUB/WAVE admin"');
  return res.status(401).json({ error: 'admin auth required' });
}
