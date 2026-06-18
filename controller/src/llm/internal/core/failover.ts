// Primary→fallback failover harness + the success/failure record writers.
//
// Every primitive (djText / djObject / djAgent) runs its per-leg generation
// inside withFailover(): the primary leg is tried first, and the call retries
// once against the optional fallback leg when the primary leg can't recover this
// call — either its host is unreachable (connection refused / DNS / timeout —
// see isUnreachable) or it refused with a quota/usage-limit/auth error (see
// isQuotaOrAuthError; issue #438). record* lives here so a call is logged
// exactly once, with the leg that actually ran.

import { primaryLeg, fallbackLeg } from '../provider/legs.js';
import { record } from '../telemetry/log.js';
import { isUnreachable, isQuotaOrAuthError } from './pure.js';

// Centralised success/failure record writers. Every LLM call goes through one
// of each. The required-shape args (kind/started/via/sampling/usage for
// success, kind/started/via/error for failure) are explicit so a new primitive
// can't silently lack a field — the `usage: undefined` drift in the Ollama
// tool-call branch was the kind of bug this prevents. Per-primitive payload
// (system, messages, toolCalls, response, user, …) goes in `extra`.
function recordSuccess({ kind, started, via, model, sampling, usage, extra = {} }: any) {
  record({
    kind,
    ok: true,
    ms: Date.now() - started,
    model,
    via,
    sampling,
    usage,
    t: new Date().toISOString(),
    ...extra,
  });
}

function recordFailure({ kind, started, via, model, error, extra = {} }: any) {
  record({
    kind,
    ok: false,
    ms: Date.now() - started,
    model,
    via,
    error,
    t: new Date().toISOString(),
    ...extra,
  });
}

// Tee a one-line preview of the failed model output to the console so failures
// are visible in `docker logs` without grepping /debug JSON. Truncated to avoid
// dumping multi-kilobyte reasoning blocks into the terminal.
function logFailurePreview(kind: string, err: any) {
  if (typeof err?.text !== 'string' || !err.text.trim()) return;
  const preview = err.text.replace(/\s+/g, ' ').trim().slice(0, 240);
  console.log(`[${kind}] raw model output (truncated): ${preview}`);
}

// The shape a single per-leg attempt returns for recording.
export interface AttemptResult<T> {
  value: T;
  via: string;
  sampling?: any;
  usage?: any;
  extra?: any;
}

// Run an LLM operation with primary→fallback failover. `attempt(leg)` performs
// one full generation against a single leg and returns a record-ready result;
// it throws on error, optionally tagging the error with `__via` so the failure
// record attributes to the right sub-path (djObject/djAgent set this). The
// primary leg is tried first; only when the primary leg can't recover this call
// — host unreachable OR a quota/usage-limit/auth rejection — and only when a
// fallback is configured, is `attempt` retried once against the backup leg.
// On a failover the primary's failure is also recorded (via `…:failover→<backup>`)
// so /debug shows the switch happened.
//
// `pin` overrides leg selection: instead of trying the primary and failing over,
// the call runs exactly once against the named leg with NO cross-leg failover —
// any error propagates so the caller can manage its own leg (the library tagger
// pins one consumer per leg, discussion #320). Records carry a `…:pinned` via
// suffix so /stats' exact-match buckets stay untouched. Unpinned calls are the
// untouched primary→fallback path.
export async function withFailover<T>(
  kind: string,
  failExtra: (err: any) => any,
  attempt: (leg: any) => Promise<AttemptResult<T>>,
  pin?: 'primary' | 'fallback',
): Promise<T> {
  if (pin) {
    const leg = pin === 'fallback' ? fallbackLeg() : primaryLeg();
    if (!leg) throw new Error(`withFailover: pinned leg "${pin}" is not configured`);
    const started = Date.now();
    try {
      const r = await attempt(leg);
      recordSuccess({ kind, started, via: `${r.via}:pinned`, model: leg.label, sampling: r.sampling, usage: r.usage, extra: r.extra });
      return r.value;
    } catch (err: any) {
      logFailurePreview(kind, err);
      recordFailure({ kind, started, via: `${err?.__via || 'ai-sdk'}:pinned`, model: leg.label, error: err?.message, extra: failExtra(err) });
      throw err;
    }
  }
  const primary = primaryLeg();
  const primaryStarted = Date.now();
  try {
    const r = await attempt(primary);
    recordSuccess({ kind, started: primaryStarted, via: r.via, model: primary.label, sampling: r.sampling, usage: r.usage, extra: r.extra });
    return r.value;
  } catch (err: any) {
    const primaryVia = err?.__via || 'ai-sdk';
    const quotaOrAuth = isQuotaOrAuthError(err);
    const backup = (isUnreachable(err) || quotaOrAuth) ? fallbackLeg() : null;
    if (!backup) {
      logFailurePreview(kind, err);
      recordFailure({ kind, started: primaryStarted, via: primaryVia, model: primary.label, error: err?.message, extra: failExtra(err) });
      throw err;
    }
    const reason = quotaOrAuth ? 'refused (quota/auth)' : 'unreachable';
    const detail = err?.statusCode || err?.cause?.statusCode || err?.code || err?.cause?.code || err?.name || 'unknown';
    console.log(`[${kind}] primary LLM (${primary.label}) ${reason} (${detail}) — failing over to ${backup.label}`);
    recordFailure({ kind, started: primaryStarted, via: `${primaryVia}:failover→${backup.label}`, model: primary.label, error: err?.message, extra: failExtra(err) });
    const backupStarted = Date.now();
    try {
      const r = await attempt(backup);
      recordSuccess({ kind, started: backupStarted, via: r.via, model: backup.label, sampling: r.sampling, usage: r.usage, extra: r.extra });
      return r.value;
    } catch (err2: any) {
      logFailurePreview(kind, err2);
      recordFailure({ kind, started: backupStarted, via: err2?.__via || 'ai-sdk', model: backup.label, error: err2?.message, extra: failExtra(err2) });
      throw err2;
    }
  }
}
