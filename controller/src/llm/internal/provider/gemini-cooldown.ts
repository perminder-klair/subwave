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

/** Park window when Google gave no usable hint, or told us the day is gone.
 *  Randomised so ten keys sharing one quota policy don't all wake together and
 *  stampede the same minute of the next day. */
export function noHintCooldownMs(random: () => number = Math.random): number {
  const spread = GEMINI_NO_HINT_MAX_MS - GEMINI_NO_HINT_MIN_MS;
  return GEMINI_NO_HINT_MIN_MS + Math.floor(random() * spread);
}

/** The whole policy in one decision: daily exhaustion (or silence) parks for
 *  hours; a real RetryInfo is taken at its word. */
export function resolveGeminiCooldownMs(
  raw: unknown,
  random: () => number = Math.random,
): number {
  if (hasDailyQuotaViolation(raw)) return noHintCooldownMs(random);
  return parseGeminiRetryDelayMs(raw) ?? noHintCooldownMs(random);
}
