// Pure, side-effect-free LLM helpers — the unit-test seam.
//
// Everything here is a pure function of its arguments: no imports from `ai`,
// `settings`, `fs`, or any module with side effects. That's deliberate — these
// are the regression-critical bits (the failover gate, the JSON salvage, the
// usage normaliser), so they live in one importable, testable place
// (controller/scripts/llm-pure.test.ts pins their behaviour).

// ---------------------------------------------------------------------------
// Thinking-block stripping
// ---------------------------------------------------------------------------
//
// Some models (Qwen 3, DeepSeek R1, etc.) emit a <think>…</think> reasoning
// block before the answer. Reasoning is suppressed at the provider layer when
// `llm.reasoning` is off (provider no-think fetch + the Ollama `think` flag);
// we still strip any leftover tags defensively here.
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>\s*/gi;
const DANGLING_THINK_RE = /^[\s\S]*?<\/think>\s*/i;

export function stripThinking(s: any): any {
  if (!s) return s;
  return s.replace(THINK_TAG_RE, '').replace(DANGLING_THINK_RE, '').trim();
}

// Pull a JSON object out of a free-text reply: drop ```json fences and any
// prose around it, then take the outermost { … }. Used by djObject's recovery
// path when native structured output fails to parse.
export function extractJson(s: any): string {
  if (!s) throw new Error('empty model response');
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model response');
  return t.slice(start, end + 1);
}

// Normalise the AI SDK usage block into { input, output, total }. Providers
// vary in which fields they populate (and a local Ollama box often omits them
// entirely — token stats then read as 0 for that call). `totalUsage` is the
// agent-loop sum across steps; prefer it when present.
export function usageOf(result: any): { input: number; output: number; total: number } {
  const u = result?.totalUsage || result?.usage || {};
  const input = u.inputTokens ?? u.promptTokens ?? 0;
  const output = u.outputTokens ?? u.completionTokens ?? 0;
  const total = u.totalTokens ?? (input + output);
  return { input, output, total };
}

// ---------------------------------------------------------------------------
// Daily LLM token budget
// ---------------------------------------------------------------------------
//
// The DJ runs 24/7 and calls the model on essentially every track transition
// (plus links/segments), so on a metered provider it can quietly accumulate. A
// daily token cap is a safety net against bill-shock: when the day's usage
// approaches the cap we drop to a cheaper picker and mute optional segments
// ('soft'); when it hits the cap we stop calling the model entirely ('hard')
// and the station coasts on the LLM-free auto playlist — music never stops.
//
// Pure so the policy is unit-pinned (scripts/llm-pure.test.ts). The caller owns
// reading the running token count (telemetry/budget.ts) and the cap/threshold
// (settings.llm); this just maps them to a mode.
//   cap <= 0            → disabled, always 'normal' (the default — most installs
//                         run free local Ollama and must be unaffected).
//   used >= cap         → 'hard'
//   used >= cap*soft%   → 'soft' (only when 0 < softPct < 100; softPct 0 or 100
//                         disables the soft tier and goes straight to hard).
export function budgetMode(
  { used, cap, softPct }: { used: number; cap: number; softPct: number },
): 'normal' | 'soft' | 'hard' {
  if (!Number.isFinite(cap) || cap <= 0) return 'normal';
  if (used >= cap) return 'hard';
  if (softPct > 0 && softPct < 100 && used >= cap * (softPct / 100)) return 'soft';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Transient vs unreachable error classification
// ---------------------------------------------------------------------------
//
// Four classifiers gate two different recovery mechanisms:
//   isTransient         → withTransientRetry retries on the SAME leg (5xx / plain 429 / socket).
//   isUnreachable       → withFailover switches to the BACKUP leg (host is DOWN).
//   isQuotaOrAuthError  → withFailover switches to the BACKUP leg (host UP but
//                         refusing this leg: quota/usage-limit/billing 429, or
//                         an auth failure — retrying the same model is futile).
//   isUpstreamOverloaded→ withFailover switches to the BACKUP leg (a reachable
//                         gateway relayed a saturated upstream — see below).
// isUnreachable is a strict subset of isTransient: it EXCLUDES 408/425/429/5xx,
// because a host that answers with a status is reachable — those stay with
// transient retry on the configured model rather than being masked by a silent
// failover to a different model (discussion #320). The ONE exception is a
// quota/auth rejection (isQuotaOrAuthError): the leg answered, but it can't
// recover this call, so it is pulled OUT of the transient set and fails over
// instead of pointlessly retrying a dead leg (issue #438 — Ollama Cloud's
// "weekly usage limit" 429s looped on the exhausted leg and never failed over).
//
// isUpstreamOverloaded is the inverse-shaped sibling: it is ADDED to the
// failover set but deliberately LEFT IN the transient set. An OpenRouter
// "Upstream error from <provider>: ResourceExhausted" (issue #671) or an
// Anthropic 529 "Overloaded" means the chosen model/route is saturated right
// now — which, unlike a quota cap, CAN clear in a second. So withTransientRetry
// gets first crack on the chosen model (honouring #320); only when the overload
// persists past that budget does withFailover try the configured fallback model,
// instead of the call dying on the saturated route having never tried the backup.

// The AI SDK's built-in retry (generateText's default maxRetries: 2) throws
// AI_RetryError once its attempts are spent — a wrapper with NO statusCode,
// cause, or responseHeaders of its own. The real APICallError (with the 429
// status and the Retry-After header) lives in err.lastError / err.errors[].
// Every classifier below unwraps first, or a rate-limited/quota/overloaded
// call that the SDK already retried would classify as nothing at all and
// never fail over (PR #751 review). Duck-typed on the wrapper's fields, not
// RetryError.isInstance, so this file keeps its no-`ai`-import purity.
export function unwrapSdkError(err: any): any {
  if (!err) return err;
  const inner = err.lastError
    ?? (Array.isArray(err.errors) && err.errors.length ? err.errors[err.errors.length - 1] : undefined);
  return inner ?? err;
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODE = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

export function isTransient(err: any): boolean {
  if (!err) return false;
  err = unwrapSdkError(err);
  // A quota/usage-limit/auth rejection is permanent for THIS leg this call —
  // never burn same-leg retries on it; let it propagate to withFailover, which
  // switches legs (#438). A plain rate-limit 429 (no quota/auth signature) is
  // unaffected and stays transient below.
  if (isQuotaOrAuthError(err)) return false;
  const status = err.statusCode ?? err.status ?? err.cause?.statusCode ?? err.cause?.status;
  if (typeof status === 'number' && TRANSIENT_STATUS.has(status)) return true;
  const code = err.code ?? err.cause?.code;
  if (typeof code === 'string' && TRANSIENT_CODE.has(code)) return true;
  const name = err.name ?? err.cause?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const msg = String(err.message || err.cause?.message || '');
  if (/\b(408|425|429|500|502|503|504)\b/.test(msg)) return true;
  if (/socket hang up|fetch failed|network.*(error|timeout)/i.test(msg)) return true;
  return false;
}

// Host-unreachable: the primary box is DOWN, not merely busy. A strict subset
// of isTransient — connection refused / DNS failure / connect timeout / socket
// hang-up. Deliberately EXCLUDES 408/425/429 and 5xx (see above). This is what
// gates failover to the backup leg. NOTE: the AgentDeadlineError raised by
// withDeadline deliberately does NOT match here (its name is neither AbortError
// nor TimeoutError, and its message carries no network signature) — a model
// that overthinks past the deadline is not a host that's down.
const UNREACHABLE_CODE = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
]);

export function isUnreachable(err: any): boolean {
  if (!err) return false;
  err = unwrapSdkError(err);
  const code = err.code ?? err.cause?.code;
  if (typeof code === 'string' && UNREACHABLE_CODE.has(code)) return true;
  const name = err.name ?? err.cause?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const msg = String(err.message || err.cause?.message || '');
  if (/fetch failed|socket hang up|getaddrinfo|connect ECONNREFUSED|connect ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return true;
  }
  return false;
}

// Provider refused this leg in a way that retrying the SAME model won't fix
// this call: a quota / usage-limit / billing rejection, or an authentication
// failure (bad / missing API key). The host is UP (it answered), so this is NOT
// isUnreachable — but unlike a transient "slow down" 429, the same leg can't
// recover, so withFailover treats it like host-down and switches to the backup
// leg (issue #438). Detected by message because providers surface quota/auth
// differently and the AI SDK often flattens the status into the message text;
// a bare 429 with no quota signature stays a plain transient rate-limit.
// "requires more credits" / "can only afford" are OpenRouter's per-request
// affordability 402 — no "insufficient"/"quota" token, so it only classified
// while the 402 status survived; match it by text too (Discord out-of-credit run).
const QUOTA_RE = /usage limit|quota|exceeded your current|insufficient[ _]?(quota|funds|credit|balance)|requires more credits|can only afford|upgrade for higher|out of credit|payment required/i;
const AUTH_RE = /invalid[ _]?api[ _]?key|incorrect[ _]?api[ _]?key|unauthorized|authentication (failed|error)|forbidden|api key (not|is|was) /i;

export function isQuotaOrAuthError(err: any): boolean {
  if (!err) return false;
  err = unwrapSdkError(err);
  const status = err.statusCode ?? err.status ?? err.cause?.statusCode ?? err.cause?.status;
  // Auth: any 401/403, or an auth-shaped message regardless of status.
  if (status === 401 || status === 403) return true;
  // Quota/billing: a payment-required status, or a quota-shaped message. NOTE a
  // bare 429 is deliberately NOT enough — only a 429 whose message names a
  // quota/usage-limit qualifies (via QUOTA_RE below).
  if (status === 402) return true;
  const msg = String(err.message || err.cause?.message || '');
  if (AUTH_RE.test(msg)) return true;
  if (QUOTA_RE.test(msg)) return true;
  return false;
}

// A reachable gateway relayed a saturated upstream: the host answered, but the
// model/route it fronts is at capacity right now. OpenRouter surfaces this as
// "Upstream error from <provider>: ResourceExhausted: Worker local total
// request limit reached (32/32)" (issue #671); Anthropic as a 529 "Overloaded";
// Vertex/gRPC as RESOURCE_EXHAUSTED. Unlike a quota cap this is NOT the user's
// account being out of credit (so it is NOT isQuotaOrAuthError) and the host is
// UP (so it is NOT isUnreachable) — it is a transient capacity blip that CAN
// clear on a retry. So it deliberately STAYS in the transient set
// (withTransientRetry gets first crack on the chosen model); withFailover then
// adds it as a failover trigger, so a persistent overload finally tries the
// configured fallback model rather than dying on the saturated route. Matched
// by message because the signal is in the relayed text, plus Anthropic's 529.
// Kept tight to avoid stealing plain rate-limit 429s (which should stay same-leg
// transient retries): only an explicit upstream/overload/exhausted phrase or a
// 529 qualifies — a bare 503 or "rate limit exceeded, slow down" does not.
const UPSTREAM_OVERLOAD_RE = /upstream error|resource[ _]?exhausted|overloaded|no instances?\b.*\bavailable|worker local total request limit/i;

export function isUpstreamOverloaded(err: any): boolean {
  if (!err) return false;
  err = unwrapSdkError(err);
  const status = err.statusCode ?? err.status ?? err.cause?.statusCode ?? err.cause?.status;
  if (status === 529) return true; // Anthropic "Overloaded" — outside TRANSIENT_STATUS
  const msg = String(err.message || err.cause?.message || '');
  return UPSTREAM_OVERLOAD_RE.test(msg);
}

// A plain rate-limit 429 with no quota/usage-limit wording (issue #738): the
// free-tier daily/per-minute request cap on a provider like Gemini/Groq/
// OpenRouter. This is the case isQuotaOrAuthError deliberately does NOT catch
// (see its comment above), so it stays isTransient and gets same-leg retries
// first via withTransientRetry. If those retries exhaust and the 429 is still
// live, withFailover treats it the same as a quota/auth rejection and switches
// to the backup leg — a request-per-minute/day cap on the primary provider is
// exactly the "keep the station on air on a free tier" case the issue asks
// for, and retrying the same exhausted leg forever will never recover it.
//
// Deliberately NOT any bare 429: a status alone must also carry rate-limit
// wording or a Retry-After header to qualify. A self-hosted llama.cpp/vLLM box
// answering 429 on a momentary concurrency spike sends neither — that stays a
// plain same-leg transient retry and never silently switches the station onto
// a (possibly paid) cloud fallback (PR #751 review). Every provider #738
// names does send the wording and/or the header.
const RATE_LIMIT_RE = /rate.?limit|too many requests|requests? per (?:minute|day|hour)|\b[rt]p[mdh]\b/i;

export function isRateLimited(err: any): boolean {
  if (!err) return false;
  err = unwrapSdkError(err);
  const status = err.statusCode ?? err.status ?? err.cause?.statusCode ?? err.cause?.status;
  const msg = String(err.message || err.cause?.message || '');
  const is429 = status === 429 || (status == null && /\b429\b/.test(msg));
  if (!is429) return false;
  const headers = err.responseHeaders ?? err.cause?.responseHeaders;
  const hasRetryAfter = !!(headers?.['retry-after'] ?? headers?.['retry-after-ms']);
  return hasRetryAfter || RATE_LIMIT_RE.test(msg);
}

// A short, actionable reason string for logs. A network-transport failure
// surfaces as undici's opaque `TypeError: fetch failed` — the real errno
// (ECONNRESET / ENOTFOUND / ETIMEDOUT / UND_ERR_*) lives on err.cause.code,
// NOT err.code, so a log that only reads err.code/status prints "unknown" for
// exactly the case an operator most needs to see (a request that never reached
// the provider — Discord: "it's not even seeing requests"). Digs into the cause
// and appends the errno/status to the message when it adds something.
export function errReason(err: any): string {
  if (!err) return 'unknown';
  err = unwrapSdkError(err);
  const msg = String(err.message || err.cause?.message || '').trim();
  const code = err.code ?? err.cause?.code;
  const status = err.statusCode ?? err.status ?? err.cause?.statusCode ?? err.cause?.status;
  const detail = typeof code === 'string' ? code : typeof status === 'number' ? String(status) : '';
  if (msg && detail && !msg.includes(detail)) return `${msg.slice(0, 100)} (${detail})`;
  return msg.slice(0, 100) || detail || 'unknown';
}

// ---------------------------------------------------------------------------
// Tool-call / diagnostics extraction
// ---------------------------------------------------------------------------

// Flatten a tool-loop result's discovery-tool trail for /debug. Excludes the
// synthetic `done` tool — it's the schema-emit signal, not a real discovery
// action. Shared by the native-output and done-tool branches of djAgent.
export function flattenToolCalls(result: any): any[] {
  return ((result?.steps as any) || []).flatMap((s: any) => {
    const results = s.toolResults || [];
    return (s.toolCalls || [])
      .filter((c: any) => c.toolName !== 'done')
      .map((c: any, i: number) => ({
        name: c.toolName,
        args: c.input ?? c.args ?? null,
        result: results[i]?.output ?? results[i]?.result ?? null,
      }));
  });
}

// Pull diagnostic info off an AI SDK structured-output error. When the model
// emits something but the SDK can't parse it into the schema, the raw text
// lives on err.text (and the original cause on err.cause). Without this, the
// failure record only carries err.message — useless for "WHY didn't it parse?"
// triage. Best-effort: every field is optional, missing ones are skipped.
export function failureDiagnostics(err: any): any {
  const out: any = {};
  if (typeof err?.text === 'string') out.responseText = err.text;
  if (err?.finishReason) out.finishReason = err.finishReason;
  if (err?.usage) out.usage = usageOf({ usage: err.usage });
  if (err?.cause?.message && err.cause.message !== err.message) {
    out.causeMessage = err.cause.message;
  }
  // The agent loop's partial steps before the final-output failure — same
  // shape as the success-path toolCalls flatten.
  const steps = err?.response?.steps || err?.steps;
  if (Array.isArray(steps) && steps.length) {
    out.toolCalls = steps.flatMap((s: any) => {
      const results = s.toolResults || [];
      return (s.toolCalls || []).map((c: any, i: number) => ({
        name: c.toolName,
        args: c.input ?? c.args ?? null,
        result: results[i]?.output ?? results[i]?.result ?? null,
      }));
    });
    out.steps = steps.length;
  }
  return out;
}
