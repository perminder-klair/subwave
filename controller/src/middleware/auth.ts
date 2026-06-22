import { timingSafeEqual } from 'node:crypto';
import { clientIp } from './ratelimit.js';
import {
  loadCredentials, saveCredentials, hashPassword, verifyPassword,
  type AdminCredentials,
} from './admin-credentials.js';

const IS_PROD = process.env.NODE_ENV === 'production';
// 10 strikes before a temporary lockout: brute-forcing a real password in 10
// tries is implausible, while an operator (or a household behind one NAT IP)
// fat-fingering the password a few times shouldn't get locked out for 15 min.
const MAX_AUTH_FAILURES = 10;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000;
const authAttempts = new Map<string, { failures: number; lockedUntil: number }>();

let adminUser = '';
let cachedCreds: AdminCredentials | null = null;
export let ADMIN_AUTH_REQUIRED = false;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Called once at startup, before initAdminCredentials. Exits the process if a
// production deploy has no credentials at all (neither hash file nor env vars).
export function assertAdminConfigured() {
  const envUser = process.env.ADMIN_USER || '';
  const envPass = process.env.ADMIN_PASS || '';
  const hasEnv = Boolean(envUser && envPass);
  const hasCreds = loadCredentials() !== null;

  if (IS_PROD && !hasEnv && !hasCreds) {
    console.error(
      '[auth] FATAL: NODE_ENV=production but no admin credentials found.\n' +
      '       Either set ADMIN_USER and ADMIN_PASS in .env, or ensure\n' +
      '       state/admin-hash.json exists from a prior boot.'
    );
    process.exit(1);
  }
}

// Loads (or migrates) admin credentials into memory. Call after secrets are
// loaded but before any admin route can fire.
export async function initAdminCredentials(): Promise<void> {
  const envUser = process.env.ADMIN_USER || '';
  const envPass = process.env.ADMIN_PASS || '';
  const existing = loadCredentials();

  if (existing) {
    cachedCreds = existing;
    adminUser = existing.user;
    ADMIN_AUTH_REQUIRED = true;

    if (envPass) {
      console.warn(
        '[auth] ADMIN_PASS found in .env but hashed credentials exist. ' +
        'Remove ADMIN_PASS from .env for security.'
      );
    }
    console.log('[auth] admin gate ENABLED (hashed credentials)');
    return;
  }

  if (envUser && envPass) {
    adminUser = envUser;
    const { hash, salt } = await hashPassword(envPass);
    await saveCredentials(envUser, hash, salt);
    cachedCreds = loadCredentials();
    ADMIN_AUTH_REQUIRED = true;

    // Do NOT try to strip ADMIN_PASS from .env -- in Docker the container
    // can't write the host file (it arrives via env_file, not a bind mount).
    // Warn the operator to remove it manually.
    console.log('[auth] migrated ADMIN_PASS to hashed storage (state/admin-hash.json)');
    console.warn(
      '[auth] ADMIN_PASS is still in .env. Remove it manually for security -- ' +
      'the hash file is now the sole credential source.'
    );
    return;
  }

  ADMIN_AUTH_REQUIRED = false;
  console.log('[auth] admin gate disabled (set ADMIN_USER+ADMIN_PASS to enable)');
}

export function requireAdmin(req, res, next) {
  if (!ADMIN_AUTH_REQUIRED) return next();

  // Lockout keys on clientIp() -- the left-most X-Forwarded-For -- which is
  // client-controlled and therefore spoofable: an attacker can rotate the
  // header per request to dodge this counter. So this is defense-in-depth that
  // slows casual brute-forcing from a single source, not a hard guarantee. For
  // durable enforcement put a real rate limit at the edge (Caddy/Cloudflare),
  // where the connecting IP is known before it gets flattened into a header.
  const ip = clientIp(req);
  const now = Date.now();
  const rec = authAttempts.get(ip);

  // Once a lockout window has elapsed, clear the counter so the operator gets a
  // fresh set of MAX_AUTH_FAILURES attempts. Without this, failures stays >=
  // MAX_AUTH_FAILURES after the first lockout, so the very next wrong attempt
  // immediately re-locks for another window -- effectively one try every 15 min.
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
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="SUB/WAVE admin"');
    return res.status(401).json({ error: 'admin auth required' });
  }

  // Split on the FIRST colon only: per RFC 7617 the userid can't contain a
  // colon but the password can, so split(':') would truncate any password
  // with a ':' in it and reject otherwise-correct credentials.
  let u: string, p: string;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    u = sep === -1 ? decoded : decoded.slice(0, sep);
    p = sep === -1 ? '' : decoded.slice(sep + 1);
  } catch {
    res.setHeader('WWW-Authenticate', 'Basic realm="SUB/WAVE admin"');
    return res.status(401).json({ error: 'admin auth required' });
  }

  if (!safeEqual(u, adminUser)) {
    failAuth(ip, now, rec, res);
    return;
  }

  if (!cachedCreds) {
    res.setHeader('WWW-Authenticate', 'Basic realm="SUB/WAVE admin"');
    return res.status(401).json({ error: 'admin auth required' });
  }

  verifyPassword(p, cachedCreds.hash, cachedCreds.salt, cachedCreds.scryptParams)
    .then(valid => {
      if (valid) {
        if (rec) authAttempts.delete(ip);
        return next();
      }
      failAuth(ip, now, rec, res);
    })
    .catch(() => {
      res.status(500).json({ error: 'auth verification failed' });
    });
}

function failAuth(
  ip: string,
  now: number,
  rec: { failures: number; lockedUntil: number } | undefined,
  res,
) {
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
