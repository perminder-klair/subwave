// How long a Google API key is unusable after a 429.
//
// The distinction that matters is DAILY exhaustion versus a per-minute
// throttle. A free-tier key that has burnt its day quota comes back with a
// QuotaFailure naming a `…PerDay…` quotaId; waiting out the seconds-scale
// RetryInfo on it would just burn another 429, because nothing clears until
// midnight. The reverse mistake is worse in the other direction: parking a key
// for hours because a per-minute burst happened would cost a whole key for a
// one-second wait.
//
// So: a daily violation (or a body with no usable hint at all) parks the key
// on the hours scale; an explicit short RetryInfo is honoured exactly.
//
// Pure and network-free — `scripts/gemini-cooldown.test.ts` is the seam.

/** "22s" | "500ms" | "2m" | "1.5h" | "1d" → ms. null when unparseable. */
export function parseDurationMs(raw: unknown): number | null {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^([\d.]+)\s*(ms|s|m|h|d)$/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = m[2].toLowerCase();
  const factor = unit === 'ms' ? 1
    : unit === 's' ? 1000
    : unit === 'm' ? 60_000
    : unit === 'h' ? 3_600_000
    : 86_400_000;
  const ms = Math.round(value * factor);
  return Number.isSafeInteger(ms) ? ms : null;
}

const RETRY_INFO_TYPE = 'type.googleapis.com/google.rpc.RetryInfo';
const QUOTA_FAILURE_TYPE = 'type.googleapis.com/google.rpc.QuotaFailure';

/** RetryInfo.retryDelay out of an error body's `details[]`, the authoritative
 *  source. Prefers it over the prose hint because it is machine-readable. */
function retryDelayFromDetails(details: unknown): number | null {
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    if ((d as any)?.['@type'] !== RETRY_INFO_TYPE) continue;
    const ms = parseDurationMs((d as any).retryDelay);
    if (ms != null) return ms;
  }
  return null;
}

function bodyText(raw: unknown): string {
  if (raw == null) return '';
  return typeof raw === 'string' ? raw : safeStringify(raw);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** The delay Google actually asked for, or null when it said nothing usable.
 *  Falls back to the "Please retry in 5s" prose some error bodies carry
 *  instead of a structured detail. */
export function parseGeminiRetryDelayMs(raw: unknown): number | null {
  const text = bodyText(raw);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const fromDetails = retryDelayFromDetails(parsed?.error?.details);
    if (fromDetails != null) return fromDetails;
    const message = parsed?.error?.message;
    if (typeof message === 'string') {
      const m = message.match(/please retry in\s+([\d.]+\s*(?:ms|s|m|h|d))/i);
      if (m) {
        const ms = parseDurationMs(m[1]);
        if (ms != null) return ms;
      }
    }
  } catch {
    // Not JSON — fall through to the raw-text patterns.
  }
  const rawDelay = text.match(/"retryDelay"\s*:\s*"([^"]+)"/)?.[1];
  if (rawDelay) {
    const ms = parseDurationMs(rawDelay);
    if (ms != null) return ms;
  }
  const retryIn = text.match(/please retry in\s+([\d.]+\s*(?:ms|s|m|h|d))/i)?.[1];
  return retryIn ? parseDurationMs(retryIn) : null;
}

/** True when the 429 is a DAILY quota violation, which will not clear when a
 *  seconds-scale RetryInfo elapses.
 *
 *  The underscore is normalised away before matching: real quotaIds spell it
 *  `..._per_day` (e.g. `generate_requests_per_model_per_day`) while some
 *  responses use a bare `perday`. Matching the literal substring alone misses
 *  the underscored spelling, which is the common one — and missing it means a
 *  dead-until-tomorrow key gets parked for the 5 seconds Google nominally
 *  asked for, then burns another 429 on every call. */
function looksDaily(quotaId: unknown): boolean {
  return String(quotaId ?? '').toLowerCase().replace(/[_\-\s]/g, '').includes('perday');
}

export function hasDailyQuotaViolation(raw: unknown): boolean {
  const text = bodyText(raw);
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    const details = parsed?.error?.details;
    if (Array.isArray(details)) {
      return details.some((d: any) => (
        d?.['@type'] === QUOTA_FAILURE_TYPE
        && Array.isArray(d?.violations)
        && d.violations.some((v: any) => looksDaily(v?.quotaId))
      ));
    }
  } catch {
    // Not JSON — fall through.
  }
  return looksDaily(text.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1]);
}

export const GEMINI_NO_HINT_MIN_MS = 60 * 60 * 1000;
export const GEMINI_NO_HINT_MAX_MS = 3 * 60 * 60 * 1000;

/** A per-second/per-minute limit clears within its own window, so when Google
 *  gives no RetryInfo the honest guess is that window — not the hours-scale
 *  park. Having `error.code` is what makes the distinction possible at all: an
 *  unlabelled 429 might be either, and only the unlabelled case has to assume
 *  the worse one. */
export const GEMINI_BURST_NO_HINT_MS = 60_000;

/** An invalid/expired credential will not fix itself between two DJ calls, so
 *  it is parked for a day — long enough to stop hammering it, short enough
 *  that replacing the key in the admin UI is picked up the next morning rather
 *  than feeling broken. */
export const GEMINI_AUTH_PARK_MS = 24 * 60 * 60 * 1000;

/**
 * What KIND of failure this is, which is the only question that changes
 * behaviour. The Interactions API documents a machine-readable `error.code`,
 * and that is the signal we trust — `quota_exceeded` says "your daily quota"
 * outright, which removes the guesswork that used to come from having to infer
 * it from a quotaId substring.
 *
 *   daily   — the daily quota is gone. Hours, not seconds.
 *   burst   — per-second/per-minute limit. Google says how long; take its word.
 *   auth    — the credential itself is rejected (401). Dead until replaced, and
 *             the one non-429 that must still rotate: the next key may be fine.
 *   billing — prepay credits depleted (402). NOT a key problem and NOT
 *             transient; documented as "don't retry", and usually means every
 *             key on the project shares the balance. Parking here would take
 *             the station down quietly instead of surfacing what is wrong.
 *   other   — anything else, including every generation-blocked code (safety,
 *             recitation, language, …). Those are the CONTENT being refused,
 *             not the credential: another key would refuse the same input, so
 *             rotating would burn the pool to no effect.
 */
export type GeminiFailure = 'daily' | 'burst' | 'auth' | 'billing' | 'other';

const DAILY_CODES = new Set(['quota_exceeded']);
const BURST_CODES = new Set(['rate_limit_exceeded', 'too_many_requests']);

export function classifyGeminiFailure(raw: unknown): GeminiFailure {
  const text = bodyText(raw);
  if (!text) return 'other';
  try {
    const parsed = JSON.parse(text);
    const code = String(parsed?.error?.code || '').toLowerCase();
    if (DAILY_CODES.has(code)) return 'daily';
    if (BURST_CODES.has(code)) return 'burst';
    if (code === 'authentication') return 'auth';
    if (code === 'payment_required') return 'billing';
  } catch {
    // Not JSON — fall through to the structured details below.
  }
  // Gateway fallback: an intermediary (or an older API surface) may rewrite
  // the body and drop `code`, so the details[] inspection still earns its
  // keep. Order matters — a PerDay violation wins even when a short RetryInfo
  // rides along with it, which is the whole trap.
  if (hasDailyQuotaViolation(raw)) return 'daily';
  if (parseGeminiRetryDelayMs(raw) != null) return 'burst';
  return 'other';
}

/** Park window when Google gave no usable hint, or told us the day is gone.
 *  Randomised so ten keys sharing one quota policy don't all wake together and
 *  stampede the same minute of the next day. */
export function noHintCooldownMs(random: () => number = Math.random): number {
  const spread = GEMINI_NO_HINT_MAX_MS - GEMINI_NO_HINT_MIN_MS;
  return GEMINI_NO_HINT_MIN_MS + Math.floor(random() * spread);
}

/** The whole policy in one decision, driven by the classified failure rather
 *  than by sniffing the body twice:
 *
 *   daily   → hours, randomised (nothing clears at the RetryInfo's scale)
 *   burst   → exactly what Google asked for, or hours if it said nothing
 *   auth    → a day; the credential itself is rejected
 *   billing → deliberately NOT parked; surfacing beats a quiet station
 *   other   → a bare 429 with no hint at all is still treated as exhausted
 *             rather than retried immediately, which is the conservative read
 */
export function resolveGeminiCooldownMs(
  raw: unknown,
  random: () => number = Math.random,
  consecutiveFailures = 0,
): number {
  const kind = classifyGeminiFailure(raw);
  switch (kind) {
    case 'daily':
      return noHintCooldownMs(random);
    case 'burst': {
      // An explicit RetryInfo is taken AT ITS WORD, even against the escalation
      // below. Google said twenty seconds; holding the key a minute because it
      // keeps failing would shrink the pool for no reason, and the whole point
      // of this class is that it clears fast.
      const hint = parseGeminiRetryDelayMs(raw);
      if (hint != null) return hint;
      // No hint at all: escalate with consecutive failures, so a key that is
      // really a daily exhaustion mislabelled as a rate limit stops being
      // re-probed every minute for the rest of the day.
      const ladder = [GEMINI_BURST_NO_HINT_MS, 2 * 60_000, 5 * 60_000, 15 * 60_000, 45 * 60_000, 180 * 60_000];
      const idx = Math.min(Math.max(consecutiveFailures - 1, 0), ladder.length - 1);
      return ladder[idx];
    }
    case 'auth':
      return GEMINI_AUTH_PARK_MS;
    default:
      // 'other' only ever reaches here from a 429 (the caller gates on status),
      // where silence is the dangerous reading — hours is safe, seconds is not.
      return parseGeminiRetryDelayMs(raw) ?? noHintCooldownMs(random);
  }
}
