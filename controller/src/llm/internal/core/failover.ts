// Try the fallback on unreachable hosts, quota/auth errors (#438), persistent
// upstream overload (#671), rate limits that survived same-leg retries (#738),
// missing/retired models, or a 5xx that survived same-leg retries (a leg that
// answered but cannot serve the call — e.g. a server with no model loaded).
// A down primary is remembered for a sticky window so the next call does not
// re-pay detection; see startSticky below. Permanent model errors skip retries.
// Record each call once against the leg that actually ran.

import { createHash } from 'node:crypto';
import { wrapLanguageModel } from 'ai';
import * as settings from '../../../settings.js';
import { ollamaBaseUrl, loccaBaseUrl } from '../provider/registry.js';
import { guardGenerationModel, throwIfCancelled } from './generation.js';
import type { Leg } from '../provider/legs.js';
import { primaryLeg, fallbackLeg, probeLegReachable } from '../provider/legs.js';
import { capabilitiesFor } from '../provider/capabilities.js';
import { withRefusalFailover } from './retry-policy.js';
import { record } from '../telemetry/log.js';
import { isUnreachable, isQuotaOrAuthError, isUpstreamOverloaded, isRateLimited, isModelUnavailable, isServerExhausted, isGenerationControlError, isProviderRequestTimeout } from './pure.js';

// The server a leg talks to, credentials and query stripped. Shared by the
// generation guard's target id and the sticky window's key.
function legEndpoint(leg: Leg): string {
  const provider = leg.cfg.provider;
  let endpoint = provider === 'ollama' ? ollamaBaseUrl(leg.cfg)
    : provider === 'locca' ? loccaBaseUrl(leg.cfg)
      : provider === 'openai-compatible' ? leg.cfg.baseUrl : provider;
  try {
    const url = new URL(endpoint);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    endpoint = url.toString().replace(/\/+$/, '');
  } catch { /* Hosted default: the provider name identifies the target. */ }
  return endpoint;
}

// Calls `onAnswer` each time the provider returns a generation. Lets
// withFailover tell a model that never answered (a hang) from one that answered
// and then ran out of time (an overthinking agent).
function answerTap(model: any, onAnswer: () => void): any {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        onAnswer();
        return result;
      },
    },
  });
}

// Wrap per dispatch, never mutate cached registry models or capture old settings.
function guardedLeg(leg: Leg, kind: string, role: 'primary' | 'fallback', onAnswer?: () => void): Leg {
  const provider = leg.cfg.provider;
  const endpoint = legEndpoint(leg);
  const metadata = {
    kind, leg: role, provider, modelLabel: leg.label,
    targetId: createHash('sha256').update(`${provider}|${endpoint}`).digest('hex').slice(0, 24),
    timeoutMs: settings.get().llm.requestTimeoutMs,
  };
  const guard = (m: any) => (onAnswer ? answerTap(guardGenerationModel(m, metadata), onAnswer) : guardGenerationModel(m, metadata));
  const model = guard(leg.model);
  const noThinkModel = leg.noThinkModel === leg.model ? model : guard(leg.noThinkModel);
  return { ...leg, model, noThinkModel };
}

// Centralised success/failure record writers. Every LLM call goes through one
// of each. The required-shape args (kind/started/via/sampling/usage for
// success, kind/started/via/error for failure) are explicit so a new primitive
// can't silently lack a field — the `usage: undefined` drift in the Ollama
// tool-call branch was the kind of bug this prevents. Per-primitive payload
// (system, messages, toolCalls, response, user, …) goes in `extra`.
function recordSuccess({ kind, started, via, model, sampling, usage, contextPeakInput, perf, warnings, extra = {} }: any) {
  record({
    kind,
    ok: true,
    ms: Date.now() - started,
    model,
    via,
    sampling,
    usage,
    // For multi-step tool loops this is the largest individual model request,
    // not the accumulated billable usage. It is the number a server context
    // window must accommodate.
    ...(Number.isFinite(contextPeakInput) && contextPeakInput > 0 ? { contextPeakInput } : {}),
    // AI SDK 7 per-step performance stats (perfOf) + provider warnings
    // (warningsOf — the live "provider ignored the reasoning param" tripwire).
    // Optional: absent on results that carry no performance data.
    ...(perf ? { perf } : {}),
    ...(warnings ? { warnings } : {}),
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

// ── Sticky failover ────────────────────────────────────────────────────────
// A down primary is remembered for a window so the next call does not re-pay
// detection (connect timeouts × retries, or a full same-leg 5xx budget) before
// reaching the backup. Two classes, cleared differently:
//   unreachable — the host's port or DNS failed; probeLegReachable can tell us
//                 it is back without spending a real generation, so a
//                 background probe clears the window early.
//   exhausted   — the host answers but cannot serve (bare 500, model off); a
//                 cheap HTTP probe would say "up" while every real call still
//                 fails, so only the window expiry retries the primary. The
//                 re-detection that follows is cheap (the server answers at
//                 once), which is exactly why this class needs no probe.
//   hung        — the host accepts the call but never answers: a generation
//                 hit the provider request timeout before any model response.
//                 Detection here is the expensive case (up to the full timeout
//                 per call), so the first verdict marks the primary down at once.
//                 Expiry only, like exhausted: the server answers a probe.
// The window length depends on the class. An unreachable host has a probe to
// clear it early, so it can hold the long window. An exhausted or hung verdict
// has only the expiry, and both are common on a self-hosted primary that will
// serve again within a minute or two: a llama.cpp server answering 503 "Loading
// model" while it starts, or a cold model running into the provider request
// timeout. An agent's own deadline says nothing about provider health. These
// provider failures hold a short window, so a recovered primary is not
// left idle while a paid backup takes every call.
// One verdict is enough for every class: waiting for a second failure would
// let the next call pay the same detection again, which is the delay this
// window exists to stop. The window is tied to the primary it judged (model
// label + server): an operator who switches the primary in Settings gets the
// new one tried at once. Sticky never applies to pinned calls (an explicit leg
// choice) and only ever routes TO a configured backup — with none, the primary
// still gets its try.

interface StickyState {
  until: number;
  kind: 'unreachable' | 'exhausted' | 'hung';
  key: string;
}

const STICKY_WINDOW_MS: Record<StickyState['kind'], number> = {
  unreachable: 5 * 60_000,
  exhausted: 90_000,
  hung: 90_000,
};
const STICKY_PROBE_EVERY_MS = 30_000;

function stickyKey(leg: Leg): string {
  return `${leg.label}|${legEndpoint(leg)}`;
}

function isCurrentPrimary(leg: Leg): boolean {
  try { return stickyKey(primaryLeg()) === stickyKey(leg); } catch { return false; }
}

const STICKY_VERDICT: Record<StickyState['kind'], string> = {
  unreachable: 'unreachable',
  exhausted: 'cannot serve (5xx)',
  hung: 'not answering',
};

let sticky: StickyState | null = null;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
// Test seams: a window that overrides every class's length, and the probe
// interval, so expiry and the probe can be observed in a test.
let stickyWindowOverrideMs: number | null = null;
let stickyProbeEveryMs = STICKY_PROBE_EVERY_MS;

function stickyWindowMs(kind: StickyState['kind']): number {
  return stickyWindowOverrideMs ?? STICKY_WINDOW_MS[kind];
}

function formatWindow(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

function startSticky(kind: StickyState['kind'], leg: Leg): StickyState | null {
  if (!isCurrentPrimary(leg)) return null;
  const windowMs = stickyWindowMs(kind);
  sticky = { until: Date.now() + windowMs, kind, key: stickyKey(leg) };
  console.log(`[failover] primary LLM (${leg.label}) ${STICKY_VERDICT[kind]} — routing to the backup for ${formatWindow(windowMs)}`);
  if (kind === 'unreachable') scheduleStickyProbe();
  return sticky;
}

// The window holds only for the primary it judged. A different primary (the
// operator switched model or server) clears it rather than inheriting it.
function stickyHolds(primary: Leg): boolean {
  if (!sticky) return false;
  if (sticky.key !== stickyKey(primary) || Date.now() >= sticky.until) {
    clearSticky();
    return false;
  }
  return true;
}

function clearSticky(): void {
  sticky = null;
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
}

function scheduleStickyProbe(): void {
  if (probeTimer) return;
  probeTimer = setTimeout(async () => {
    probeTimer = null;
    if (!sticky || sticky.kind !== 'unreachable' || Date.now() >= sticky.until) return;
    let leg: Leg;
    try { leg = primaryLeg(); } catch { return; }
    if (stickyKey(leg) !== sticky.key) { clearSticky(); return; }
    if (!capabilitiesFor(leg.cfg.provider).reachabilityProbe) return;
    const down = sticky;
    let up = false;
    try { up = await probeLegReachable(leg, 3000); } catch { up = false; }
    if (sticky !== down) return;
    if (up) {
      clearSticky();
      console.log('[failover] primary LLM reachable again — back to normal routing');
      return;
    }
    scheduleStickyProbe();
  }, stickyProbeEveryMs);
  probeTimer.unref?.();
}

// What /debug shows while LLM calls are not going where they should go first.
// Every unpinned call runs through withFailover, so the routing it chose is
// recorded there, in one place, whatever sent the call to the backup: D5's
// sticky window, or a one-off failover (retired model, quota/auth refusal,
// rate limit, overloaded upstream, unreachable host, 5xx). The record opens
// on the first call routed to the backup and is cleared by the first call the
// primary answers again. Pinned calls never touch it: an explicit leg choice
// (the tagger pins both legs) is routing as intended.
//
// Read-only: a /debug poll never changes routing. The snapshot drops a record
// the next call would not honour: the primary was switched in Settings (the
// new one is tried at once) or no usable backup is configured any more.
export interface FailoverRouting {
  reason: string;          // why calls went to the backup (latest call's reason)
  since: number;           // first call routed to the backup in this run
  lastAt: number;          // latest call routed to the backup
  calls: number;           // calls routed to the backup since `since`
  lastOk?: boolean;        // absent until the latest call has an outcome
  provider: string;        // the backup that took them
  model: string;
  // Set while D5's sticky window holds: when the primary will be tried again.
  // Absent when the next call tries the primary first anyway.
  retryPrimaryAt?: number;
}

interface BackupRoutingState {
  primaryKey: string;
  reason: string;
  since: number;
  lastAt: number;
  calls: number;
  lastOk?: boolean;
  provider: string;
  model: string;
}

let backupRouting: BackupRoutingState | null = null;

function noteRoutedToBackup(primary: Leg, backup: Leg, reason: string): BackupRoutingState | null {
  if (!isCurrentPrimary(primary)) return null;
  const now = Date.now();
  const primaryKey = stickyKey(primary);
  const same = backupRouting && backupRouting.primaryKey === primaryKey && backupRouting.model === backup.label;
  backupRouting = {
    primaryKey,
    reason,
    since: same ? backupRouting!.since : now,
    lastAt: now,
    calls: same ? backupRouting!.calls + 1 : 1,
    provider: String(backup.cfg?.provider || ''),
    model: backup.label,
  };
  return backupRouting;
}

function noteBackupResult(routing: BackupRoutingState | null, ok: boolean): void {
  if (routing && backupRouting === routing) routing.lastOk = ok;
}

function isBackupFailure(err: Parameters<typeof isGenerationControlError>[0], signal?: AbortSignal): boolean {
  return !signal?.aborted && (!isGenerationControlError(err) || isProviderRequestTimeout(err));
}

export function failoverRoutingSnapshot(now: number = Date.now()): FailoverRouting | null {
  if (!backupRouting) return null;
  let primary: Leg;
  try { primary = primaryLeg(); } catch { return null; }
  if (stickyKey(primary) !== backupRouting.primaryKey) return null;
  if (!fallbackLeg()) return null;
  const { primaryKey: _key, ...shown } = backupRouting;
  const holding = sticky && sticky.key === backupRouting.primaryKey && now < sticky.until;
  return holding ? { ...shown, retryPrimaryAt: sticky!.until } : shown;
}

// Test seam: drop the sticky state (and any pending probe) between scenarios,
// and optionally shorten the window (every class) and the probe interval so an
// expiry or a probe can be observed in a test. A call without arguments
// restores the production defaults.
export function resetFailoverStickyForTest(windowMs?: number, probeEveryMs?: number): void {
  clearSticky();
  backupRouting = null;
  stickyWindowOverrideMs = windowMs ?? null;
  stickyProbeEveryMs = probeEveryMs ?? STICKY_PROBE_EVERY_MS;
}

// The shape a single per-leg attempt returns for recording.
export interface AttemptResult<T> {
  value: T;
  via: string;
  sampling?: any;
  usage?: any;
  contextPeakInput?: number;
  // perfOf(result) — aggregated AI SDK step performance for /debug + events.
  perf?: any;
  // warningsOf(result) — provider warnings (e.g. unsupported reasoning param).
  warnings?: string[];
  extra?: any;
}

// Run an LLM operation with primary→fallback failover. `attempt(leg)` performs
// one full generation against a single leg and returns a record-ready result;
// it throws on error, optionally tagging the error with `__via` so the failure
// record attributes to the right sub-path (djObject/djAgent set this). The
// primary leg is tried first; only when the primary leg can't recover this call
// — host unreachable OR a quota/usage-limit/auth rejection OR a reachable
// gateway relaying a saturated upstream (#671) OR a rate limit that survived
// same-leg retries (#738 — a free-tier request cap) OR a permanently missing
// model OR a 5xx that survived same-leg retries (a leg that answered but cannot
// serve the call, e.g. a server with no model loaded) — and only when a
// fallback is configured, is `attempt` retried once against the backup leg.
// On a failover the primary's failure is also recorded (via `…:failover→<backup>`)
// so /debug shows the switch happened. A host-down failure (unreachable or
// exhausted) also starts the sticky window above, so the NEXT call goes
// straight to the backup without re-paying detection.
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
  signal?: AbortSignal,
): Promise<T> {
  const runAttempt = (leg: Leg, role: 'primary' | 'fallback', onAnswer?: () => void) => withRefusalFailover(
    () => !pin && role === 'primary' && fallbackLeg() != null,
    () => attempt(guardedLeg(leg, kind, role, onAnswer)),
  );
  throwIfCancelled(signal);
  if (pin) {
    const leg = pin === 'fallback' ? fallbackLeg() : primaryLeg();
    if (!leg) throw new Error(`withFailover: pinned leg "${pin}" is not configured`);
    const started = Date.now();
    try {
      const r = await runAttempt(leg, pin);
      recordSuccess({ kind, started, via: `${r.via}:pinned`, model: leg.label, sampling: r.sampling, usage: r.usage, contextPeakInput: r.contextPeakInput, perf: r.perf, warnings: r.warnings, extra: r.extra });
      return r.value;
    } catch (err: any) {
      logFailurePreview(kind, err);
      recordFailure({ kind, started, via: `${err?.__via || 'ai-sdk'}:pinned`, model: leg.label, error: err?.message, extra: failExtra(err) });
      throw err;
    }
  }
  const primary = primaryLeg();
  // Sticky: a primary marked down by the last real failure is not re-tried
  // while the window holds — the backup takes the call without paying
  // detection again. With no configured backup there is nowhere to route, so
  // the primary still gets its normal try.
  if (stickyHolds(primary)) {
    const backup = fallbackLeg();
    if (backup) {
      const down = sticky;
      const started = Date.now();
      console.log(`[${kind}] primary LLM (${primary.label}) marked down — using ${backup.label} without retrying it`);
      const routing = noteRoutedToBackup(primary, backup, `primary marked down: ${STICKY_VERDICT[sticky!.kind]}`);
      try {
        const r = await runAttempt(backup, 'fallback');
        noteBackupResult(routing, true);
        recordSuccess({ kind, started, via: r.via, model: backup.label, sampling: r.sampling, usage: r.usage, contextPeakInput: r.contextPeakInput, perf: r.perf, warnings: r.warnings, extra: r.extra });
        return r.value;
      } catch (err2: any) {
        if (isBackupFailure(err2, signal)) noteBackupResult(routing, false);
        logFailurePreview(kind, err2);
        recordFailure({ kind, started, via: err2?.__via || 'ai-sdk', model: backup.label, error: err2?.message, extra: failExtra(err2) });
        // Both legs failing: routing to the backup no longer saves anything,
        // and a primary that recovered would sit unused until expiry while
        // every call fails. Clear the window so the next call tries the
        // primary — at most one call is lost this way. A cancelled call says
        // nothing about the backup, so it leaves the window alone.
        if (isBackupFailure(err2, signal) && sticky === down) {
          clearSticky();
          console.log(`[failover] backup LLM (${backup.label}) failed too — the primary is tried again on the next call`);
        }
        throw err2;
      }
    }
  }
  const primaryStarted = Date.now();
  let primaryAnswered = false;
  try {
    const r = await runAttempt(primary, 'primary', () => { primaryAnswered = true; });
    if (sticky?.key === stickyKey(primary)) clearSticky();
    if (backupRouting?.primaryKey === stickyKey(primary)) backupRouting = null;
    recordSuccess({ kind, started: primaryStarted, via: r.via, model: primary.label, sampling: r.sampling, usage: r.usage, contextPeakInput: r.contextPeakInput, perf: r.perf, warnings: r.warnings, extra: r.extra });
    return r.value;
  } catch (err: any) {
    const primaryVia = err?.__via || 'ai-sdk';
    const quotaOrAuth = isQuotaOrAuthError(err);
    const upstreamOverloaded = isUpstreamOverloaded(err);
    const rateLimited = isRateLimited(err);
    const modelGone = isModelUnavailable(err);
    const serverExhausted = isServerExhausted(err);
    const backup = ((!isGenerationControlError(err) || isProviderRequestTimeout(err))
      && !signal?.aborted
      && (isUnreachable(err) || quotaOrAuth || upstreamOverloaded || rateLimited || modelGone || serverExhausted))
      ? fallbackLeg()
      : null;
    if (!backup) {
      logFailurePreview(kind, err);
      recordFailure({ kind, started: primaryStarted, via: primaryVia, model: primary.label, error: err?.message, extra: failExtra(err) });
      throwIfCancelled(signal);
      throw err;
    }
    const reason = isProviderRequestTimeout(err)
      ? 'generation timed out'
      : modelGone ? 'model unavailable'
      : quotaOrAuth ? 'refused (quota/auth)'
      : upstreamOverloaded ? 'upstream overloaded'
      : rateLimited ? 'rate limited'
      : serverExhausted ? 'cannot serve (5xx after retries)'
      : 'unreachable';
    const detail = err?.statusCode || err?.cause?.statusCode || err?.code || err?.cause?.code || err?.name || 'unknown';
    console.log(`[${kind}] primary LLM (${primary.label}) ${reason} (${detail}) — failing over to ${backup.label}`);
    recordFailure({ kind, started: primaryStarted, via: `${primaryVia}:failover→${backup.label}`, model: primary.label, error: err?.message, extra: failExtra(err) });
    // Only a host-down verdict starts the sticky window. A retired model or a
    // spent quota keeps the host healthy and its errors are immediate — there
    // is no detection cost worth remembering, and marking a healthy box down
    // would steer calls away from it for nothing. A request timeout reads the
    // same way as an agent deadline: after an earlier step of this call got an
    // answer, the model is slow (overthinking), not hung, so this call fails
    // over but the next one still tries the primary.
    const stickyKind = reason === 'unreachable' ? 'unreachable'
      : reason === 'cannot serve (5xx after retries)' ? 'exhausted'
      : reason === 'generation timed out' && !primaryAnswered ? 'hung'
      : null;
    const down = stickyKind ? startSticky(stickyKind, primary) : null;
    throwIfCancelled(signal);
    const routing = noteRoutedToBackup(primary, backup, `primary ${reason}`);
    const backupStarted = Date.now();
    try {
      const r = await runAttempt(backup, 'fallback');
      noteBackupResult(routing, true);
      recordSuccess({ kind, started: backupStarted, via: r.via, model: backup.label, sampling: r.sampling, usage: r.usage, contextPeakInput: r.contextPeakInput, perf: r.perf, warnings: r.warnings, extra: r.extra });
      return r.value;
    } catch (err2: any) {
      if (isBackupFailure(err2, signal)) {
        noteBackupResult(routing, false);
        if (down && sticky === down) clearSticky();
      }
      logFailurePreview(kind, err2);
      recordFailure({ kind, started: backupStarted, via: err2?.__via || 'ai-sdk', model: backup.label, error: err2?.message, extra: failExtra(err2) });
      throw err2;
    }
  }
}
