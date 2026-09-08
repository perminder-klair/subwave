// Throttling for /request (per-IP cooldown + per-IP and station-wide hourly
// caps), the station-password box and listener-auth. All state is in-memory, so
// a restart resets counters; durable enforcement belongs at the Caddy edge.
import * as settings from '../settings.js';

export const REQUESTS_DISABLED = process.env.REQUESTS_DISABLED === '1' || process.env.REQUESTS_DISABLED === 'true';

// Read per call so admin edits apply without a restart. Defaults mirror settings.ts.
function limits() {
  const rq = (settings.get() as any)?.requests || {};
  return {
    cooldownMs: (Number(rq.cooldownSec) > 0 ? Number(rq.cooldownSec) : 60) * 1000,
    perIpHourlyCap: Number(rq.perIpHourlyCap) > 0 ? Number(rq.perIpHourlyCap) : 8,
    globalHourlyCap: Number(rq.globalHourlyCap) > 0 ? Number(rq.globalHourlyCap) : 30,
  };
}

const requestHistory = new Map(); // ip → { last: ts, hits: [ts,...] }

// Opt-in: trust `CF-Connecting-IP` as the client identity. Off by default; the
// default is the safe one (see clientIp).
export const TRUST_CF_CONNECTING_IP =
  process.env.TRUST_CF_CONNECTING_IP === '1' || process.env.TRUST_CF_CONNECTING_IP === 'true';

// The one parse of the raw header. NOT a trusted identity on its own — only
// clientIp() (gated) and analytics may call it.
export function unverifiedCfIp(req): string {
  return String(req.headers['cf-connecting-ip'] || '').trim();
}

// The identity EVERY per-IP gate keys on (request cooldown/caps, requireAdmin
// lockout, station-password throttle, like dedup), so the order is a security
// decision: cf-connecting-ip ONLY behind TRUST_CF_CONNECTING_IP, then left-most
// x-forwarded-for, then the socket peer. The header is gated because Caddy
// passes it through unfiltered while it discards a forged XFF from a non-
// Cloudflare peer; trusting it unconditionally is a one-header bypass. With
// Cloudflare in front the reverse holds — it APPENDS to XFF, so xff[0] is
// attacker-controlled. Either way this only holds if the origin is reachable
// solely through that edge.
export function clientIp(req) {
  if (TRUST_CF_CONNECTING_IP) {
    const cf = unverifiedCfIp(req);
    if (cf) return cf;
  }
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff[0] || req.socket.remoteAddress || 'unknown';
}

// The two budgets are spent at different times. `rec.last` (the cooldown) is
// spent on EVERY attempt — it is the backpressure on rejected retries. The
// hourly caps (`rec.hits` / `globalHits`) are budgets of ACCEPTED requests and
// must only be spent on acceptance, or rejected retries close the request line
// station-wide. So check() spends the cooldown and only PEEKS at the caps;
// commit() spends them, once every later gate has passed.
export function checkRateLimit(ip) {
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  const rec = requestHistory.get(ip) || { last: 0, hits: [] };
  rec.hits = rec.hits.filter(t => t > oneHourAgo);
  const { cooldownMs, perIpHourlyCap } = limits();
  if (rec.last && now - rec.last < cooldownMs) {
    return { ok: false, retryAfter: Math.ceil((cooldownMs - (now - rec.last)) / 1000) };
  }
  if (rec.hits.length >= perIpHourlyCap) {
    const oldest = rec.hits[0];
    return { ok: false, retryAfter: Math.ceil((oldest + 3_600_000 - now) / 1000) };
  }
  rec.last = now;
  requestHistory.set(ip, rec);
  // Opportunistic cleanup so the map doesn't grow unbounded over weeks.
  if (requestHistory.size > 2000) {
    for (const [k, v] of requestHistory) {
      if (!v.hits.length && now - v.last > 3_600_000) requestHistory.delete(k);
    }
  }
  return { ok: true };
}

// Spend the per-IP hourly budget; call only once the request is being accepted.
// Touches `hits` only — stamping `last` here would double-charge the cooldown.
// A missing record (evicted by the janitor between check and commit) is seeded
// with a clear cooldown, so eviction fails open.
export function commitRateLimit(ip) {
  const rec = requestHistory.get(ip) || { last: 0, hits: [] };
  rec.hits.push(Date.now());
  requestHistory.set(ip, rec);
}

// All-IP combined ceiling; per-IP buckets are useless against a distributed raid.
const globalHits: number[] = [];

// Peek only. Pair every ok:true with commitGlobalRateLimit() at the accept point.
export function checkGlobalRateLimit() {
  const now = Date.now();
  const cutoff = now - 3_600_000;
  while (globalHits.length && globalHits[0] <= cutoff) globalHits.shift();
  const { globalHourlyCap } = limits();
  if (globalHits.length >= globalHourlyCap) {
    return { ok: false, retryAfter: Math.ceil((globalHits[0] + 3_600_000 - now) / 1000) };
  }
  return { ok: true };
}

export function commitGlobalRateLimit() {
  globalHits.push(Date.now());
}

// Station-password attempts (#478): no cooldown, just a hard ceiling per window
// — a typo must not lock out a legitimate listener the way /request's cooldown
// would. Each SURFACE gets its own bucket keyed (surface, ip) so a stale-password
// API integration cannot burn the attempts a human on the same address needs.
const AUTH_WINDOW_MS = 15 * 60_000;
const AUTH_WINDOW_CAP = 20;
const authHistories = new Map(); // surface → Map(ip → [ts, ...])

function authHistoryFor(surface) {
  let h = authHistories.get(surface);
  if (!h) { h = new Map(); authHistories.set(surface, h); }
  return h;
}

export function checkAuthRateLimit(ip, surface = 'station-auth') {
  const now = Date.now();
  const cutoff = now - AUTH_WINDOW_MS;
  const authHistory = authHistoryFor(surface);
  const hits = (authHistory.get(ip) || []).filter(t => t > cutoff);
  if (hits.length >= AUTH_WINDOW_CAP) {
    return { ok: false, retryAfter: Math.ceil((hits[0] + AUTH_WINDOW_MS - now) / 1000) };
  }
  hits.push(now);
  authHistory.set(ip, hits);
  if (authHistory.size > 2000) {
    for (const [k, v] of authHistory) {
      if (!v.some(t => t > cutoff)) authHistory.delete(k);
    }
  }
  return { ok: true };
}

// Listener-auth brute-force damper (#478). Deliberately delays FAILURES rather
// than gating the request: a cap would have to reject correct passwords once
// tripped, which locks real listeners out of a private stream. Counted globally,
// since behind Icecast every call arrives from one address. O(1) counter.
const LISTENER_FAIL_WINDOW_MS = 15 * 60_000;
const LISTENER_FAIL_STEP_MS = 250;
const LISTENER_FAIL_MAX_DELAY_MS = 2_000;
let listenerFailWindowStart = 0;
let listenerFailCount = 0;

export function listenerAuthFailureDelayMs(now = Date.now()) {
  if (now - listenerFailWindowStart > LISTENER_FAIL_WINDOW_MS) {
    listenerFailWindowStart = now;
    listenerFailCount = 0;
  }
  listenerFailCount += 1;
  return Math.min(listenerFailCount * LISTENER_FAIL_STEP_MS, LISTENER_FAIL_MAX_DELAY_MS);
}

// Test seam.
export function resetListenerAuthFailures() {
  listenerFailWindowStart = 0;
  listenerFailCount = 0;
}
