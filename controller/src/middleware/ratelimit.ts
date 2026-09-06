// ---------------------------------------------------------------------------
// Request endpoint throttling. The /request path triggers an LLM call,
// Subsonic searches, TTS, and a booth-log write — cheap individually but
// trivially weaponisable by anyone with curl. Defence in depth:
//   - hard size caps on text + name (schemas/request.ts, enforced at the
//     route boundary by validateBody)
//   - operator kill switch (REQUESTS_DISABLED env)
//   - per-IP cooldown (no more than 1 request per COOLDOWN_MS)
//   - per-IP hourly ceiling
//   - station-wide hourly ceiling (2026-07-28: raid hardening)
// State is in-memory; a controller restart resets counters. Good enough for a
// homelab station; if you need durable enforcement, put a real ratelimit at
// the Caddy edge.
// ---------------------------------------------------------------------------
import * as settings from '../settings.js';

export const REQUESTS_DISABLED = process.env.REQUESTS_DISABLED === '1' || process.env.REQUESTS_DISABLED === 'true';

// Live limits from settings.requests (raid hardening 2026-07-28) — read per
// call so admin edits apply without a restart. Defaults mirror settings.ts.
function limits() {
  const rq = (settings.get() as any)?.requests || {};
  return {
    cooldownMs: (Number(rq.cooldownSec) > 0 ? Number(rq.cooldownSec) : 60) * 1000,
    perIpHourlyCap: Number(rq.perIpHourlyCap) > 0 ? Number(rq.perIpHourlyCap) : 8,
    globalHourlyCap: Number(rq.globalHourlyCap) > 0 ? Number(rq.globalHourlyCap) : 30,
  };
}

const requestHistory = new Map(); // ip → { last: ts, hits: [ts,...] }

// OPT-IN: trust `CF-Connecting-IP` as the client identity. Off by default, and
// the default is the safe one — read clientIp() below before flipping it.
export const TRUST_CF_CONNECTING_IP =
  process.env.TRUST_CF_CONNECTING_IP === '1' || process.env.TRUST_CF_CONNECTING_IP === 'true';

// The raw header read, shared so there is one parse of it in the tree. NOT a
// trusted identity on its own — only clientIp() (gated) and analytics (which
// accepts an untrusted hint by design) may call it.
export function unverifiedCfIp(req): string {
  return String(req.headers['cf-connecting-ip'] || '').trim();
}

// The identity EVERY per-IP gate keys on — the /request cooldown + per-IP
// hourly cap + one-pending hold, `requireAdmin`'s brute-force lockout
// (middleware/auth.ts), the station-password throttle (routes/public.ts), and
// per-IP like dedup (routes/likes.ts). A wrong answer here weakens all of them
// at once, so the resolution order is a security decision, not plumbing:
//
//   1. `cf-connecting-ip` — ONLY when TRUST_CF_CONNECTING_IP is set.
//   2. left-most `x-forwarded-for`.
//   3. the socket peer.
//
// Why the header is gated rather than simply preferred: on the shipped stack
// the only peer is Caddy, and `docker/Caddyfile` lists Cloudflare's ranges as
// `trusted_proxies` — so Caddy DISCARDS a client-supplied X-Forwarded-For
// unless the connection really came from a Cloudflare edge, and `xff[0]` is
// the true peer. `CF-Connecting-IP` gets no such treatment: it is an ordinary
// header Caddy passes straight through. Trusting it unconditionally would
// therefore hand every attacker a one-header bypass of all of the above on
// exactly the deployments that were previously sound — an honest client never
// sends it, so "absent by default" is not a defence.
//
// With the flag ON (proxied-DNS Cloudflare in front, the documented prod
// topology) the header is the right answer and XFF is the wrong one, because
// Cloudflare APPENDS the real client IP to the chain rather than replacing it
// — a client-supplied left-most entry survives the edge intact.
//
// Still true either way: this is only as good as the guarantee that the origin
// is reachable ONLY through that edge. Anyone who can hit it directly can
// forge whichever header is being trusted (`docker-compose.byo.yml` binds the
// controller on a host port by design). Durable enforcement belongs at the
// edge — see the header comment.
export function clientIp(req) {
  if (TRUST_CF_CONNECTING_IP) {
    const cf = unverifiedCfIp(req);
    if (cf) return cf;
  }
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff[0] || req.socket.remoteAddress || 'unknown';
}

// The two budgets here are spent at DIFFERENT times, and conflating them was a
// live bug. POST /request has gates after these (the one-pending hold, the
// maxPending queue-depth cap) that reject without queueing anything, and the
// counters were already incremented by the time those ran:
//
//   * `rec.last` (the cooldown) SHOULD be spent on every attempt. It is the
//     anti-hammer, it is per-IP, and it clears itself in cooldownSec. Not
//     spending it on rejections would leave the queue-full path with no
//     backpressure at all — an unthrottled loop that re-runs listeners.refresh()
//     (an Icecast round-trip) every time.
//   * `rec.hits` / `globalHits` (the hourly caps) are budgets of ACCEPTED
//     requests and must only be spent when one is actually accepted. Charging
//     them for rejections is self-inflicted denial of service: with the queue
//     full at maxPending=6, thirty rejected retries burned the whole
//     globalHourlyCap=30 and closed the request line station-wide for an hour
//     with six requests actually taken. The per-IP version locked a single
//     impatient listener out for an hour the same way.
//
// So check() spends the cooldown and PEEKS at the hourly caps; commit() spends
// the hourly caps, and POST /request calls it only once every gate has passed.
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

// Spend the per-IP hourly budget. Call only once the request is being accepted.
// Touches `hits` and nothing else — the cooldown is checkRateLimit's business,
// and a commit that also stamped `last` would double-charge it. Tolerates a
// missing record (the janitor above can evict between check and commit) by
// seeding one with a clear cooldown, so a commit is never silently dropped and
// an eviction fails open rather than locking the IP out.
export function commitRateLimit(ip) {
  const rec = requestHistory.get(ip) || { last: 0, hits: [] };
  rec.hits.push(Date.now());
  requestHistory.set(ip, rec);
}

// All-IP combined ceiling — per-IP buckets are useless against a distributed
// raid (2026-07-28: ~106 requests from many addresses inside 5 hours).
const globalHits: number[] = [];

// Peek only — see the note above checkRateLimit for why this must not spend the
// budget. Pair every ok:true with commitGlobalRateLimit() at the accept point.
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

// ---------------------------------------------------------------------------
// Station-password attempts (#478). A separate bucket from the /request one
// above, deliberately shaped differently: /request throttles an expensive
// side-effecting action, so it can afford a 60s cooldown and 8/hour (the
// settings-driven defaults). A password box can't — one typo would lock a
// legitimate listener out for a full minute, and a household sharing a NAT
// would exhaust 8/hour in a sitting.
//
// So: no cooldown, but a hard ceiling per window. Generous enough that real
// people never notice, tight enough that the shared password isn't
// brute-forceable over HTTP. In-memory like the above; a controller restart
// resets it, which is fine — an attacker gains one window, not the password.
// ---------------------------------------------------------------------------
//
// Each SURFACE gets its own bucket, keyed (surface, ip). The player's password
// box and the station-gated API reads (GET /similar-tracks) share the ceiling
// SHAPE but never the counter: an operator's call-in agent left polling with a
// stale password would otherwise burn the twenty attempts a HUMAN on that
// address needs to get into the player, so a misconfigured integration could
// lock a listener out of the station. Each surface keeps its own brute-force
// bound — the split loosens nothing, it just stops one surface starving
// another. Pass the surface explicitly; the default is the password box.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Listener-auth brute-force damper (#478 hardening).
//
// POST /listener-auth answers 200/401 on the shared privacy.password, so it is
// a password oracle for anyone who can reach it. The bundled Caddyfiles now 404
// it at the edge (Icecast calls the controller directly, never through the
// proxy), but docker-compose.byo.yml operators write their own route table and
// may forward it, so the handler carries its own bound too.
//
// This deliberately does NOT gate the request the way checkAuthRateLimit does.
// A cap that rejects over-budget attempts would have to reject CORRECT
// passwords once tripped — otherwise 429-vs-401 is the same oracle — and that
// hands an attacker a trivial way to lock every real listener out of a private
// stream. Instead only FAILURES are slowed: a legitimate listener presenting
// the right password is never delayed or denied, while a brute-forcer drops
// from full server speed to a crawl. Counted globally rather than per-IP
// because behind Icecast every call arrives from one address anyway.
//
// Counter is O(1) (window start + count, not a timestamp array) so a flood
// can't grow it.
// ---------------------------------------------------------------------------
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

// Test seam — lets the unit test start from a known window.
export function resetListenerAuthFailures() {
  listenerFailWindowStart = 0;
  listenerFailCount = 0;
}
