// A pool of Google API keys with per-key holds, shared by the Gemini LLM leg
// and (once #1718's engine is wired up) Gemini TTS.
//
// Why a pool and not a rotation: free-tier keys are cheap and plentiful, and a
// station running one exhausts its daily quota long before it notices. The
// behaviour wanted is fail-forward — use key 1 until it stops working, park it
// for as long as Google says, move to key 2, and only fall through to the
// station's configured backup leg when the whole pool is spent.
//
// Selection is deliberately PRIMARY-FIRST rather than round-robin. Key 1 keeps
// its quota for as long as possible, and the operator's first key stays the one
// that gets tested and reported on.
//
// Holds are IN MEMORY. A controller restart re-probes keys that are still
// exhausted; they are re-parked from the same 429 within one call, which is
// cheaper than a second writer on the state dir and than persisting a wall-clock
// that is meaningless to a key whose quota resets on Google's schedule, not
// ours.
//
// Absent configuration, EVERY function here is a no-op and the module is
// invisible: an upgraded station with one key behaves exactly as before.

import { createHash } from 'node:crypto';
import {
  classifyGeminiFailure,
  resolveGeminiCooldownMs,
} from '../llm/internal/provider/gemini-cooldown.js';

export const GOOGLE_KEYS_ENV = 'GOOGLE_GENERATIVE_AI_API_KEYS';
export const GOOGLE_KEY_ENV = 'GOOGLE_GENERATIVE_AI_API_KEY';

/** A Google API key is `AIza` + 35 chars today. The bound is generous on
 *  purpose: this is a length guard against a pasted paragraph, not a format
 *  check, because a future key shape must not silently drop keys. */
export const GOOGLE_KEY_MAX = 200;
export const GOOGLE_POOL_MAX = 50;

interface Hold {
  until: number;
  /** Mirrors GeminiFailure, minus 'billing'/'other' which never park. */
  reason: 'daily' | 'burst' | 'auth' | 'unknown';
}

export interface PoolEntry {
  key: string;
  /** Operator's label. Empty = unnamed, and the UI falls back to a fingerprint. */
  name: string;
}

let holds = new Map<string, Hold>();

// Consecutive failures without an intervening success, per key. This is the
// circuit-breaker state, and it matters most for `burst`.
//
// A per-minute limit really does clear in a minute, but a key whose DAILY
// quota is gone can also arrive labelled as a rate limit — and a flat
// one-minute hold then means probing that key every minute for the rest of the
// day. With a pool that is the difference between one request per call and a
// handful of wasted probes every minute, which is exactly what makes an
// exhausted pool feel slow. Escalating turns the churn into a few probes over
// an hour, then settles at the ceiling.
//
// Reset on success, so a key that recovers is trusted again immediately.
const strikes = new Map<string, number>();
let poolCache: { entries: PoolEntry[]; at: number } | null = null;

// Parsed on every access in principle; cached briefly so a hot loop (the DJ
// fires many calls a minute) does not re-parse the environment each time. The
// TTL is short enough that a key added at runtime is picked up almost at once.
const POOL_CACHE_MS = 2_000;

export const GOOGLE_KEY_NAME_MAX = 60;

/**
 * Split a configured pool into entries.
 *
 * Comma-separated on purpose: Google keys never contain a comma, and
 * `secrets.env` is read by dotenv as single-line values — a multi-line quoted
 * list is dropped by that reader with a warning.
 *
 * An entry is `key` or `key:name`. The name lives INSIDE the same variable as
 * the key rather than in a parallel array, because a separate list of names
 * indexed against a list of keys is exactly the shape that drifts: remove or
 * reorder a key in one place and the names silently reattach to the wrong
 * credentials. A Google key is `AIza` plus URL-safe base64 and cannot contain a
 * colon, so the FIRST colon is an unambiguous split point, and a name may
 * itself contain colons. Commas are stripped from names on the way in because
 * they would otherwise split an entry in two.
 *
 * An entry with no colon is unnamed — which is what every pre-existing pool
 * looks like, so this format is a pure superset of the one already on disk.
 */
export function parsePool(raw: string | undefined | null): PoolEntry[] {
  if (!raw) return [];
  const out: PoolEntry[] = [];
  const seen = new Set<string>();
  for (const part of String(raw).split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const colon = entry.indexOf(':');
    const key = (colon === -1 ? entry : entry.slice(0, colon)).trim();
    if (!key || key.length > GOOGLE_KEY_MAX) continue;
    const name = colon === -1 ? '' : sanitizeName(entry.slice(colon + 1));
    if (seen.has(key)) continue; // a pasted duplicate is one key, not two slots
    seen.add(key);
    out.push({ key, name });
    if (out.length >= GOOGLE_POOL_MAX) break;
  }
  return out;
}

/** Commas would split an entry in two; the rest is display-only tidying. The
 *  whitespace collapse matters: a naive replace would leave `Free,  one` with
 *  a double space from every separator the operator typed. */
export function sanitizeName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[,\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GOOGLE_KEY_NAME_MAX);
}

/** Inverse of parsePool. Entries with no name serialise as a bare key, so a
 *  pool nobody has labelled still reads as a plain list of keys by hand. */
export function serializePool(entries: PoolEntry[]): string {
  return entries
    .map(({ key, name }) => (name ? `${key}:${sanitizeName(name)}` : key))
    .join(',');
}

/**
 * The explicitly configured pool — the PLURAL variable only.
 *
 * The legacy singular `GOOGLE_GENERATIVE_AI_API_KEY` is deliberately NOT read
 * as a one-key pool. Treating it as one silently switched every existing
 * single-key station onto pool behaviour it never opted into: an unhinted 429
 * parked its only credential for 1-3 hours and every later call replayed a
 * fabricated error with no network I/O, so a station that was previously
 * recoverable by one retry went quiet instead. That breaks the upgrade
 * guarantee ("an upgraded station behaves exactly as before"), so a legacy
 * station now keeps the plain single-key transport and the single-key editing
 * flow, and the pool is inert until an operator explicitly configures it.
 *
 * KEPT FOR REFERENCE — do not restore without re-solving the failure above.
 * The fallback this replaces made `poolSize()` count a legacy single key, which
 * (a) activated holds, escalation and replay on stations that never asked for
 * them, and (b) made the admin UI treat a single-key station as "a pool is
 * configured", disabling the very field the operator needed to edit it. Both
 * were silent — the station just stopped making sound. A correct re-enable
 * would need the legacy key selectable as a pool entry WITHOUT changing its
 * failure handling, which is why `add`'s legacy-seeding comment describes the
 * behaviour rather than promising it:
 *
 *   const single = (process.env[GOOGLE_KEY_ENV] || '').trim();
 *   if (single && single.length <= GOOGLE_KEY_MAX) return [{ key: single, name: '' }];
 */
function configuredEntries(): PoolEntry[] {
  return parsePool(process.env[GOOGLE_KEYS_ENV]);
}

/** True only when the operator explicitly configured the plural pool. Every
 *  consumer that must stay inert on a legacy station tests THIS, not
 *  `poolSize()` — the two are the same thing now, but they answer different
 *  questions and conflating them is what caused the regression above. */
export function poolConfigured(): boolean {
  return poolEntries().length > 0;
}

/** Every entry, named or not, in configured order. */
export function poolEntries(): PoolEntry[] {
  const now = Date.now();
  if (poolCache && now - poolCache.at < POOL_CACHE_MS) return poolCache.entries;
  const entries = configuredEntries();
  poolCache = { entries, at: now };
  return entries;
}

/** Just the keys, in order. The hot path (currentKey) needs nothing else, and
 *  every caller that REWRITES the pool must use poolEntries/serializePool so a
 *  label can't be dropped by a reorder or a removal. */
export function poolKeys(): string[] {
  return poolEntries().map(e => e.key);
}

/** Drop the memo. The settings save path calls this after writing a new pool so
 *  the change is visible without waiting out the TTL. */
export function invalidatePool(): void {
  poolCache = null;
}

export function poolSize(): number {
  return poolKeys().length;
}

/**
 * The key to send right now: the first in configured order that is neither
 * held nor already tried on this call.
 *
 * `exclude` is REQUEST-LOCAL state and is the whole reason traversal terminates.
 * Holds alone are not a bound: a short RetryInfo (or any hint shorter than the
 * request that follows it) expires while the call is still in flight, so
 * `currentKey()` hands back the key that just failed and the transport retries
 * it — forever. With two keys, a 10ms hint and 20ms of latency that produced
 * A,B,A,B,A,B… indefinitely. At most one attempt per key per call is a property
 * of the CALL, so it is tracked per call.
 *
 * Returns '' only when nothing is configured. Note the exhausted-pool case
 * deliberately does NOT fall back to the head: a caller asking for a key must
 * not be handed one it has already been told is dead. Callers that want a real
 * attempt anyway (a one-shot preview, the Test button) ask for it explicitly.
 */
export function currentKey(exclude?: ReadonlySet<string>): string {
  const now = Date.now();
  const keys = poolKeys();
  for (const key of keys) {
    if (exclude?.has(key)) continue;
    const hold = holds.get(key);
    if (!hold || hold.until <= now) {
      if (hold) holds.delete(key);
      return key;
    }
  }
  return '';
}

/**
 * The key for a ONE-SHOT call: the live key, or — when every key is held — the
 * head anyway, so a preview or a Test-key button still gets a real answer from
 * a real request instead of failing on a transient state.
 *
 * Deliberately NOT what the rotation path uses. There, handing back a held key
 * is what produced a guaranteed extra 429 per call against a credential the
 * operator already knows is dead.
 */
export function currentKeyOrHead(exclude?: ReadonlySet<string>): string {
  return currentKey(exclude) || currentKey() || poolKeys()[0] || '';
}

/** True when every configured key is currently parked. The failover layer asks
 *  this to decide whether an exhausted pool should escalate to the backup leg
 *  immediately rather than after burning another call. */
export function allKeysHeld(): boolean {
  const keys = poolKeys();
  if (!keys.length) return false;
  const now = Date.now();
  return keys.every((k) => {
    const h = holds.get(k);
    if (!h) return false;
    if (h.until <= now) { holds.delete(k); return false; }
    return true;
  });
}

export function holdRemainingMs(key: string): number {
  const h = holds.get(key);
  if (!h) return 0;
  const left = h.until - Date.now();
  if (left <= 0) { holds.delete(key); return 0; }
  return left;
}

export function isHeld(key: string): boolean {
  return holdRemainingMs(key) > 0;
}

/** Park a key. `bodyText` is the raw error body — it carries the machine-readable
 *  `error.code`, the retry hint and the daily-vs-per-minute distinction.
 *  Returns the hold length so a caller can log it. */
export function reportKeyFailure(key: string, bodyText?: unknown): number {
  if (!key) return 0;
  const kind = classifyGeminiFailure(bodyText);
  const n = (strikes.get(key) ?? 0);
  strikes.set(key, n + 1);
  // The cooldown module owns the escalation ladder and, critically, applies it
  // ONLY when Google gave no hint — an explicit RetryInfo is never overridden.
  const ms = resolveGeminiCooldownMs(bodyText, Math.random, n + 1);
  const reason: Hold['reason'] = kind === 'daily' || kind === 'burst' || kind === 'auth'
    ? kind
    : 'unknown';
  holds.set(key, { until: Date.now() + ms, reason });
  return ms;
}

/**
 * The last quota failure seen, kept so a call made while the whole pool is held
 * can answer with a REAL 429 instead of inventing one. The transport
 * short-circuits before any network I/O in that state, and the caller
 * (`withTransientRetry` / `withFailover`) classifies what comes back — so the
 * body has to carry the provider's own words, not a synthetic stand-in.
 */
let lastFailure: { status: number; statusText: string; body: string; headers: Record<string, string> } | null = null;

// Only the headers a retry/failover classifier can actually read. Capturing all
// of them would carry provider tracing ids and connection metadata into a
// replayed response the SDK then treats as authoritative.
const REPLAYED_HEADERS = ['retry-after', 'x-ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining'] as const;

/**
 * The last quota failure, kept so a call whose whole pool is exhausted can
 * answer with a REAL 429 instead of inventing one. Headers are kept alongside
 * the body for the same reason: `Retry-After` drives how the retry layer times
 * its next attempt, so a replay without it was classified differently from the
 * original response it stands in for — and could keep the station from ever
 * selecting its backup leg.
 */
export function recordLastFailure(
  status: number,
  statusText: string,
  body: string,
  headers?: Headers | Record<string, string> | null,
): void {
  const kept: Record<string, string> = {};
  const src: { forEach?: unknown; entries?: unknown } | null | undefined =
    headers as unknown as { forEach?: unknown };
  if (headers && typeof (src as any).forEach === 'function') {
    (headers as Headers).forEach((v, k) => {
      if ((REPLAYED_HEADERS as readonly string[]).includes(k.toLowerCase())) kept[k.toLowerCase()] = v;
    });
  } else if (headers && typeof (headers as any) === 'object') {
    for (const k of REPLAYED_HEADERS) {
      const v = (headers as Record<string, string>)[k] ?? (headers as Record<string, string>)[k.toUpperCase()];
      if (typeof v === 'string') kept[k] = v;
    }
  }
  lastFailure = { status, statusText, body, headers: kept };
}

export function getLastFailure(): { status: number; statusText: string; body: string; headers: Record<string, string> } | null {
  return lastFailure;
}

/** Clear a hold — a key that just succeeded was demonstrably not exhausted, so
 *  its escalation history resets too and the next failure starts from the
 *  short interval again. */
export function reportKeySuccess(key: string): void {
  if (!key) return;
  holds.delete(key);
  strikes.delete(key);
  // The RECORDED failure is about the pool, not about one key, so a key that
  // just answered invalidates it. Left in place, an exhausted-pool replay kept
  // answering with a quota error for a pool whose keys had all since recovered
  // — the hold and the strikes were forgotten, the evidence was not (#1719).
  //
  // Cleared only when a SUCCESS actually happened. A single-key pool that
  // legitimately 429s and then succeeds elsewhere must still replay a truthful
  // failure, so this is not called on any path that did not reach a 2xx.
  lastFailure = null;
}

/**
 * Test seam: expire every hold WITHOUT forgetting the recorded failure.
 *
 * This is the state a real pool reaches on its own — a key's hold lapses with
 * time while the last 429 stays on record for the replay to carry — and it is
 * the only state in which "does a success forget the recorded failure?" is a
 * question with an answer. `__resetHoldsForTest()` clears both, so a test using
 * it to set up that state asserts a value it just zeroed.
 */
export function __expireHoldsForTest(): void {
  holds = new Map();
  strikes.clear();
}

/** Everything the admin UI needs, with no secret material in it. The
 *  fingerprint is a short suffix so an operator can tell key 3 from key 7
 *  without the value ever crossing the wire. */
export interface PoolStatus {
  /** Stable opaque identity — what every mutation addresses. */
  id: string;
  /** Position, for DISPLAY order only. Never send it back to a mutation. */
  index: number;
  fingerprint: string;
  /** Operator's label, or '' when unnamed. */
  name: string;
  held: boolean;
  holdRemainingMs: number;
  reason: Hold['reason'] | null;
  /** Consecutive failures with no success in between; 0 when the key is
   *  behaving. Surfaced so the UI can say a key is *persistently* failing
   *  rather than just briefly held. */
  strikes: number;
  current: boolean;
}

export function poolStatus(): PoolStatus[] {
  const now = Date.now();
  const current = currentKey();
  return poolEntries().map(({ key, name }, index) => {
    const hold = holds.get(key);
    const remaining = hold ? hold.until - now : 0;
    const live = remaining > 0;
    if (hold && !live) holds.delete(key);
    return {
      id: entryId(key),
      index,
      fingerprint: fingerprint(key),
      name,
      held: live,
      holdRemainingMs: live ? remaining : 0,
      reason: live ? hold!.reason : null,
      strikes: strikes.get(key) ?? 0,
      current: key === current,
    };
  });
}

/** Last 4 characters, prefixed to look deliberate in the UI. A short suffix of
 *  a 39-char key is enough to disambiguate and far too short to be useful to
 *  anyone who intercepted it. */
export function fingerprint(key: string): string {
  if (!key) return '';
  return `••••${key.slice(-4)}`;
}

/**
 * A stable, opaque identifier for one credential.
 *
 * Mutations used to address keys by INDEX, with the index range checked against
 * a fresh read. That check passes even when it should not: if another client
 * reorders [Free 1, Paid] between the render and the click, "remove index 0" is
 * still in range and deletes Paid instead — a wrong credential destroyed by a
 * request that was valid when it was written. This id is derived from the key
 * itself, so it survives a reorder, a rename and a re-render, and a stale
 * reference resolves to the key the operator actually meant (or to nothing).
 *
 * A hash rather than the key or its fingerprint: `fingerprint` is a 4-character
 * display suffix, which two keys can share, and it is deliberately shown in the
 * UI. 12 hex chars of SHA-256 identifies a 39-char key without being invertible
 * or guessable from what the admin UI already displays.
 */
export function entryId(key: string): string {
  if (!key) return '';
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * Monotonic revision of the pool, bumped by every mutation.
 *
 * Separate from the id because they answer different questions. The id says
 * "which credential"; the revision says "is the pool I am editing still the pool
 * I was shown". A client sends the revision it rendered from, and a mismatch is
 * a 409 instead of a silently overwriting write — the same lost-update the
 * mutex below prevents between concurrent requests, caught for the case where
 * the other writer's change is already visible.
 */
let revision = 0;

export function poolRevision(): number {
  return revision;
}

/** Called by the single mutation chokepoint after a successful write. */
export function bumpPoolRevision(): void {
  revision += 1;
}

/**
 * Serialises every pool mutation.
 *
 * Each handler is a read-modify-write: read the current pool, mutate, persist.
 * Two of them running concurrently both read the same starting list, so the
 * second write silently discards the first — four concurrent adds all returned
 * HTTP 200 with `count: 2` while only the last credential survived. The
 * operator was told four keys were added and got one.
 *
 * The chain is a plain promise tail rather than a lock library: it is a single
 * async resource, and callers are admin-only and rare. The generic
 * `/settings/secrets` writer joins the SAME chain, because it can write the pool
 * variable too and would otherwise interleave with these handlers.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withPoolLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  // Keep the chain alive even when this link rejects, or one failed mutation
  // would reject every later one and wedge the pool permanently.
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Test seam: forget every hold and the memo without touching configuration.
 *
 * Note this also clears `lastFailure`, so it CANNOT be used to model "the hold
 * expired but the pool's last failure is still on record" — a test that needs
 * that state must expire the holds without this. Using it produced a green test
 * that asserted nothing: the reset it called had already cleared the value the
 * next line checked.
 */
export function __resetHoldsForTest(): void {
  holds = new Map();
  strikes.clear();
  lastFailure = null;
  poolCache = null;
}
