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

/** The configured pool, or the single legacy key as a one-entry pool. */
function configuredEntries(): PoolEntry[] {
  const pooled = parsePool(process.env[GOOGLE_KEYS_ENV]);
  if (pooled.length) return pooled;
  const single = (process.env[GOOGLE_KEY_ENV] || '').trim();
  return single && single.length <= GOOGLE_KEY_MAX ? [{ key: single, name: '' }] : [];
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
 * The key to send right now: the first in configured order that is not held.
 * Returns '' only when nothing is configured — a real station with an exhausted
 * pool returns the LAST key anyway, so the caller still makes one attempt per
 * call rather than failing before it starts. The caller is what decides an
 * exhausted pool is fatal.
 */
export function currentKey(): string {
  const now = Date.now();
  const keys = poolKeys();
  for (const key of keys) {
    const hold = holds.get(key);
    if (!hold || hold.until <= now) {
      if (hold) holds.delete(key);
      return key;
    }
  }
  // Every key is held. Return the first anyway: the caller gets a real 429
  // with a real RetryInfo, which is strictly more information than guessing a
  // wait here, and it keeps one-shot callers (a preview, a Test key button)
  // working instead of failing on a transient state.
  return keys[0] || '';
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
let lastFailure: { status: number; statusText: string; body: string } | null = null;

export function recordLastFailure(status: number, statusText: string, body: string): void {
  lastFailure = { status, statusText, body };
}

export function getLastFailure(): { status: number; statusText: string; body: string } | null {
  return lastFailure;
}

/** Clear a hold — a key that just succeeded was demonstrably not exhausted, so
 *  its escalation history resets too and the next failure starts from the
 *  short interval again. */
export function reportKeySuccess(key: string): void {
  if (!key) return;
  holds.delete(key);
  strikes.delete(key);
}

/** Everything the admin UI needs, with no secret material in it. The
 *  fingerprint is a short suffix so an operator can tell key 3 from key 7
 *  without the value ever crossing the wire. */
export interface PoolStatus {
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

/** Test seam: forget every hold and the memo without touching configuration. */
export function __resetHoldsForTest(): void {
  holds = new Map();
  strikes.clear();
  lastFailure = null;
  poolCache = null;
}
