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
  /** The model this hold applies to. Quotas are per project AND per model, so a
   *  key daily-exhausted on gemini-3.8-flash may still serve gemini-flash-lite.
   *  Absent (undefined) means "all models" — the legacy behaviour before per-model
   *  holds existed, kept so a hold set before this field existed still applies. */
  model?: string;
}

export interface PoolEntry {
  key: string;
  /** Operator's label. Empty = unnamed, and the UI falls back to a fingerprint. */
  name: string;
}

let holds = new Map<string, Hold>();

// Consecutive failures without an intervening success, per key + model. This is
// the circuit-breaker state, and it matters most for `burst`. Quotas are per
// project AND per model, so a key daily-exhausted on gemini-3.8-flash can still
// serve gemini-flash-lite — each model tracks its own strikes.
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

// Composite key for the per-model hold/strike maps. A hold set before per-model
// holds existed (model === undefined) is stored under the '__all__' suffix and
// applies to every model.
function holdMapKey(key: string, model?: string): string {
  return key + '\0' + (model || '__all__');
}

// The hold for a key + model, falling back to a model-less hold. Called without
// a model, it returns any hold on the key (model-less first, then the first
// model-specific hold) — used by poolStatus and by legacy callers that don't
// know the model.
function holdFor(key: string, model?: string): Hold | undefined {
  if (model) {
    return holds.get(holdMapKey(key, model)) ?? holds.get(holdMapKey(key));
  }
  const modelLess = holds.get(holdMapKey(key));
  if (modelLess) return modelLess;
  const keyPrefix = key + '\0';
  for (const [k, v] of holds) {
    if (k.startsWith(keyPrefix) && k !== key + '\0__all__') return v;
  }
  return undefined;
}

// The highest strike count across all models for this key — what the UI shows
// as "failing N× in a row" for the key regardless of which model last failed.
function strikesFor(key: string): number {
  let max = 0;
  for (const [k, n] of strikes) {
    if (k.startsWith(key + '\0')) max = Math.max(max, n);
  }
  return max;
}
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

/** The characters this format reserves, and cannot escape.
 *
 *  A comma separates ENTRIES and the first colon separates a key from its name,
 *  so neither can appear inside a key. Neither can occur in a real Google key —
 *  `AIza` plus URL-safe base64 — but a pasted value can carry one, and the
 *  failure mode is silent and bad in both directions:
 *
 *    `AIzaX,AIzaY`  persists as TWO credentials from one paste. The operator is
 *      told one key was added and gets a pool of two, one of which they never
 *      configured and cannot explain.
 *    `AIzaX:junk`   persists as a key TRUNCATED at the colon plus a label. The
 *      pool reports a fingerprint, looks configured, and every request 401s.
 *
 *  So the entry point refuses both instead of quietly repairing them. Repairing
 *  was the alternative and it is worse: a silently mangled credential is
 *  indistinguishable from a working one until Google rejects it. */
export function poolKeyProblem(raw: unknown): string | null {
  const key = String(raw ?? '');
  if (!key) return 'key is required';
  if (key.length > GOOGLE_KEY_MAX) return `key must be at most ${GOOGLE_KEY_MAX} characters`;
  if (key.includes(',')) {
    return 'a key cannot contain a comma — it separates keys in the pool, so it would be saved as two';
  }
  if (key.includes(':')) {
    return 'a key cannot contain a colon — it separates a key from its name, so it would be saved truncated';
  }
  return null;
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

let poolEpochCounter = 0;

/** Drop the memo. The settings save path calls this after writing a new pool so
 *  the change is visible without waiting out the TTL.
 *
 *  It also bumps the pool EPOCH, and that is the load-bearing half. The provider
 *  registry caches built clients by configuration, and the pool was not part of
 *  that configuration — so an added, removed or replaced key left the cached
 *  client holding the credential it was BUILT with. The pooled transport
 *  re-stamps the key on every request, so a stale construction key is invisible
 *  while a pool exists; the moment the pool is emptied the transport stops
 *  re-stamping, the SDK falls back to the construction value, and a key the
 *  operator deleted minutes ago is what still goes on the wire. Keying the cache
 *  on this epoch is the only way a cached client can be guaranteed to match the
 *  pool it was built from.
 */
export function invalidatePool(): void {
  poolCache = null;
  poolEpochCounter += 1;
}

/** Monotonic marker for "the configured pool is not the one this client was
 *  built from". Zero on a fresh process; bumped by `invalidatePool()`. */
export function poolEpoch(): number {
  return poolEpochCounter;
}

export function poolSize(): number {
  return poolKeys().length;
}

/**
 * The key to send right now: the first in configured order that is neither
 * held for this model nor already tried on this call.
 *
 * `exclude` is REQUEST-LOCAL state and is the whole reason traversal terminates.
 * Holds alone are not a bound: a short RetryInfo (or any hint shorter than the
 * request that follows it) expires while the call is still in flight, so
 * `currentKey()` hands back the key that just failed and the transport retries
 * it — forever. With two keys, a 10ms hint and 20ms of latency that produced
 * A,B,A,B,A,B… indefinitely. At most one attempt per key per call is a property
 * of the CALL, so it is tracked per call.
 *
 * `model` scopes the hold check: a key daily-exhausted on gemini-3.8-flash may
 * still serve gemini-flash-lite, so the hold is only consulted for the model
 * this call is actually making.
 *
 * Returns '' only when nothing is configured. Note the exhausted-pool case
 * deliberately does NOT fall back to the head: a caller asking for a key must
 * not be handed one it has already been told is dead. Callers that want a real
 * attempt anyway (a one-shot preview, the Test button) ask for it explicitly.
 */
export function currentKey(exclude?: ReadonlySet<string>, model?: string): string {
  const now = Date.now();
  const keys = poolKeys();
  for (const key of keys) {
    if (exclude?.has(key)) continue;
    // Model-specific hold first, then fall back to model-less ("all models").
    const mapKey = model ? holdMapKey(key, model) : holdMapKey(key);
    let hold = holds.get(mapKey);
    if (!hold && model) hold = holds.get(holdMapKey(key));
    if (!hold || hold.until <= now) {
      if (hold) holds.delete(mapKey);
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
 * `model` scopes the hold check the same way as `currentKey()`.
 *
 * Deliberately NOT what the rotation path uses. There, handing back a held key
 * is what produced a guaranteed extra 429 per call against a credential the
 * operator already knows is dead.
 */
export function currentKeyOrHead(exclude?: ReadonlySet<string>, model?: string): string {
  return currentKey(exclude, model) || currentKey(undefined, model) || poolKeys()[0] || '';
}

/** True when every configured key is currently parked FOR THIS MODEL. The
 *  failover layer asks this to decide whether an exhausted pool should escalate
 *  to the backup leg immediately rather than after burning another call. */
export function allKeysHeld(model?: string): boolean {
  const keys = poolKeys();
  if (!keys.length) return false;
  const now = Date.now();
  return keys.every((k) => {
    const mapKey = model ? holdMapKey(k, model) : holdMapKey(k);
    const h = holds.get(mapKey);
    if (!h) {
      // No model-specific hold; check model-less ("all models") hold.
      if (!model) return false;
      const h2 = holds.get(holdMapKey(k));
      if (!h2) return false;
      if (h2.until <= now) { holds.delete(holdMapKey(k)); return false; }
      return true;
    }
    if (h.until <= now) { holds.delete(mapKey); return false; }
    return true;
  });
}

export function holdRemainingMs(key: string, model?: string): number {
  const mapKey = model ? holdMapKey(key, model) : holdMapKey(key);
  const h = holds.get(mapKey);
  if (!h) {
    if (!model) return 0;
    // No model-specific hold; fall back to model-less.
    const h2 = holds.get(holdMapKey(key));
    if (!h2) return 0;
    const left = h2.until - Date.now();
    if (left <= 0) { holds.delete(holdMapKey(key)); return 0; }
    return left;
  }
  const left = h.until - Date.now();
  if (left <= 0) { holds.delete(mapKey); return 0; }
  return left;
}

export function isHeld(key: string, model?: string): boolean {
  return holdRemainingMs(key, model) > 0;
}

/** Park a key for a model. `bodyText` is the raw error body — it carries the
 *  machine-readable `error.code`, the retry hint and the daily-vs-per-minute
 *  distinction. `model` scopes the hold: a key daily-exhausted on one model may
 *  still serve another. Returns the hold length so a caller can log it. */
export function reportKeyFailure(key: string, model?: string, bodyText?: unknown): number {
  if (!key) return 0;
  const kind = classifyGeminiFailure(bodyText);
  const mapKey = holdMapKey(key, model);
  const n = (strikes.get(mapKey) ?? 0);
  strikes.set(mapKey, n + 1);
  // The cooldown module owns the escalation ladder and, critically, applies it
  // ONLY when Google gave no hint — an explicit RetryInfo is never overridden.
  const ms = resolveGeminiCooldownMs(bodyText, Math.random, n + 1);
  const reason: Hold['reason'] = kind === 'daily' || kind === 'burst' || kind === 'auth'
    ? kind
    : 'unknown';
  holds.set(mapKey, { until: Date.now() + ms, reason, model });
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
 *  short interval again. `model` scopes which hold is cleared; a key that
  // recovered on gemini-flash-lite is not automatically trusted on
  // gemini-3.8-flash. */
export function reportKeySuccess(key: string, model?: string): void {
  if (!key) return;
  holds.delete(holdMapKey(key, model));
  holds.delete(holdMapKey(key)); // also clear any model-less ("all models") hold
  strikes.delete(holdMapKey(key, model));
  strikes.delete(holdMapKey(key));
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
  /** Which model this hold parks the key for, or null when the hold applies to
   *  every model (model-less hold set before per-model holds existed). */
  model: string | null;
  reason: Hold['reason'] | null;
  /** Consecutive failures with no success in between; 0 when the key is
   *  behaving. Surfaced so the UI can say a key is *persistently* failing
   *  rather than just briefly held. Shows the highest strike count across
   *  all models for this key. */
  strikes: number;
  current: boolean;
}

export function poolStatus(): PoolStatus[] {
  const now = Date.now();
  const current = currentKey();
  return poolEntries().map(({ key, name }, index) => {
    const hold = holdFor(key);
    const remaining = hold ? hold.until - now : 0;
    const live = remaining > 0;
    if (hold && !live) holds.delete(holdMapKey(key));
    return {
      id: entryId(key),
      index,
      fingerprint: fingerprint(key),
      name,
      held: live,
      holdRemainingMs: live ? remaining : 0,
      model: hold?.model ?? null,
      reason: live ? hold!.reason : null,
      strikes: strikesFor(key),
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
