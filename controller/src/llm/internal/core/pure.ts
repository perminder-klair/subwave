// Pure, side-effect-free LLM helpers — the unit-test seam.
//
// Everything here is a pure function of its arguments: no imports from `ai`,
// `settings`, `fs`, or any module with side effects (zod is the one
// exception — a schema-construction library, not an I/O one). That's
// deliberate — these are the regression-critical bits (the failover gate,
// the JSON salvage, the usage normaliser), so they live in one importable,
// testable place (controller/scripts/llm-pure.test.ts pins their behaviour).

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared duck-typed shapes
// ---------------------------------------------------------------------------
//
// These helpers inspect dynamic runtime values — provider error objects, the
// AI SDK's usage block, tool-call trails — whose fields vary by provider and
// aren't cleanly captured by a single SDK type. `ErrorLike` is the union of an
// Error, an AI SDK APICallError, and the AI_RetryError wrapper around them:
// every field is optional and read defensively (narrowed before use).
interface ErrorLike {
  message?: unknown;
  statusCode?: unknown;
  status?: unknown;
  code?: unknown;
  name?: unknown;
  cause?: ErrorLike;
  responseHeaders?: Record<string, string | undefined>;
  // AI_RetryError wrapper — the real APICallError lives here (see unwrapSdkError).
  lastError?: ErrorLike;
  errors?: ErrorLike[];
  // Parsed/raw upstream error body — the AI SDK attaches these to
  // APICallError, and they carry the machine-readable `error.code` that
  // isQuotaOrAuthError prefers over message-sniffing.
  data?: unknown;
  responseBody?: unknown;
  // Diagnostics fields truncationError attaches / failureDiagnostics reads.
  text?: unknown;
  finishReason?: unknown;
  usage?: unknown;
  steps?: unknown;
  response?: { steps?: unknown; messages?: unknown };
}

// The AI SDK usage block, normalised by usageOf. Providers populate different
// subsets (and a local Ollama box often omits them entirely), so every field
// is optional.
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

// A single step's tool call / result, as read off an AI SDK agent result. The
// provider-varying `input`/`args` and `output`/`result` aliases stay `unknown`.
export interface ToolCallLike {
  toolName?: string;
  input?: unknown;
  args?: unknown;
}
interface ToolResultLike {
  output?: unknown;
  result?: unknown;
}
export interface StepLike {
  toolCalls?: ToolCallLike[];
  toolResults?: ToolResultLike[];
}

// The flattened discovery-tool entry surfaced to /debug.
export interface ToolCallSummary {
  name: string | undefined;
  args: unknown;
  result: unknown;
}

// ---------------------------------------------------------------------------
// Thinking-block stripping
// ---------------------------------------------------------------------------
//
// Some models (Qwen 3, DeepSeek R1, etc.) emit a <think>…</think> reasoning
// block before the answer. Reasoning is suppressed at the provider layer when
// `llm.reasoning` is off (provider no-think fetch + the Ollama `think` flag);
// we still strip any leftover tags defensively here.
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>\s*/gi;
const CLOSE_THINK_RE = /<\/think>/i;
const ANY_THINK_TAG_RE = /<\/?think>/gi;

// Normalise a segment for the repetition check (lowercase + collapse whitespace).
function normSeg(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Harmony / channel reasoning format (gpt-oss, Gemma-4): the model emits its
// deliberation in a `thought`/`analysis` channel before the answer's `final`
// channel, e.g.
//   <|channel|>thought<|message|>…reasoning…<|channel|>final<|message|>…answer…
// On the openai-compatible path reasoning_format:"deepseek" routes this to
// reasoning_content so it never reaches us — but on a build or model that still
// leaks it into `content`, strip it here (the <think> handling above only
// catches the Qwen/R1 tag form). Some llama.cpp builds emit the tokens without
// the trailing pipe (`<|channel>thought`), so the pipe before `>` is optional.
//
// The reliable primitive is "keep only the FINAL channel's message". When no
// final channel is present the reply is all reasoning scaffolding (the answer
// got stuck in the thought channel), so we drop from the first channel opener
// on — returning '' rather than speaking the deliberation aloud.
const FINAL_CHANNEL_RE = /<\|channel\|?>\s*final\s*<\|message\|?>/gi;
const ANY_CHANNEL_OPEN_RE = /<\|channel\|?>/i;
const HARMONY_TOKENS_RE = /<\|(?:start|end|return|message|channel)\|?>/gi;

export function stripThinking(s: string): string {
  if (!s || typeof s !== 'string') return s;
  // 1. Well-formed <think>…</think> blocks.
  let t = s.replace(THINK_TAG_RE, '');
  // 2. Stray closing </think> tags with no opener. Two shapes reach here:
  //    (a) a genuine reasoning leak — `reasoning</think>answer`, ONE close tag,
  //        the answer follows it → keep the LAST segment.
  //    (b) a runaway loop where a reasoning model (thinking not actually
  //        suppressed by the endpoint, e.g. an Ollama :cloud GLM) emits </think>
  //        as a separator between repeated near-identical answers until it hits
  //        the output-token cap (live incident 2026-07-07, generateSignoff). The
  //        tail is a truncated duplicate, so keep the FIRST complete segment.
  if (CLOSE_THINK_RE.test(t)) {
    const segs = t.split(/<\/think>/i).map((x) => x.trim()).filter(Boolean);
    if (segs.length) {
      const norm = segs.map(normSeg);
      const hasRepeat = norm.some((v, i) => norm.indexOf(v) !== i);
      t = segs.length >= 3 || hasRepeat ? segs[0] : segs[segs.length - 1];
    }
  }
  // 3. Unterminated <think> opener — the output-token cap cut the model off
  //    mid-thought, so the closing tag never arrived (issue #947: a handoff
  //    greeting aired ~4000 tokens of looping deliberation, and rule 4 alone
  //    would strip just the tag and keep the body). Everything from the opener
  //    on is trapped reasoning; keep only what precedes it (the <think>-tag
  //    twin of the harmony no-final-channel rule below).
  const openThink = t.search(/<think>/i);
  if (openThink !== -1) t = t.slice(0, openThink);
  // 4. Harmony / channel reasoning — keep only the text after the LAST
  //    final-channel opener, if any.
  let lastFinalEnd = -1;
  for (const m of t.matchAll(FINAL_CHANNEL_RE)) {
    lastFinalEnd = (m.index ?? 0) + m[0].length;
  }
  if (lastFinalEnd !== -1) {
    t = t.slice(lastFinalEnd);
  } else {
    // No final channel — if any channel scaffolding is present, everything from
    // the first opener on is trapped reasoning; keep only what precedes it.
    const open = t.search(ANY_CHANNEL_OPEN_RE);
    if (open !== -1) t = t.slice(0, open);
  }
  // 5. Belt-and-suspenders — no stray <think>/</think> tag or leftover harmony
  //    control token ever reaches TTS/booth. These literals never appear in a
  //    real DJ script.
  return t.replace(ANY_THINK_TAG_RE, '').replace(HARMONY_TOKENS_RE, '').trim();
}

// A 'length' finish means the reply was cut at the output-token cap — for DJ
// free text that's always a runaway reasoning generation, never a usable
// script (issue #947: the truncated deliberation carried no closing marker for
// stripThinking to catch and aired verbatim). Returns the Error the caller
// should throw — with the raw text/usage attached so failureDiagnostics and
// the console preview still show WHY — or null when the reply finished
// normally. The message deliberately carries no digits so no transient/
// failover classifier mistakes it for a network status (pinned in
// llm-pure.test.ts). Pure so the guard itself is unit-testable.
export interface TruncationError extends Error {
  text?: string;
  finishReason: 'length';
  usage?: unknown;
}
export function truncationError(result: { finishReason?: string; text?: string; usage?: unknown }): TruncationError | null {
  if (result?.finishReason !== 'length') return null;
  const err = new Error('reply truncated at the output-token cap — refusing to air a runaway generation') as TruncationError;
  err.text = result.text;
  err.finishReason = 'length';
  err.usage = result.usage;
  return err;
}

// Pull a JSON object out of a free-text reply: drop ```json fences and any
// prose around it, then take the outermost { … }. Used by djObject's recovery
// path when native structured output fails to parse.
export function extractJson(s: string): string {
  if (!s) throw new Error('empty model response');
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model response');
  return t.slice(start, end + 1);
}

// Normalise the AI SDK usage block into { input, output, total }. Providers
// vary in which fields they populate (and a local Ollama box often omits them
// entirely — token stats then read as 0 for that call). In AI SDK 7 `usage`
// already sums across all steps (`totalUsage` is its deprecated alias); the
// alias stays as a fallback so pre-v7-shaped fixtures/results keep working.
export function usageOf(
  result: { totalUsage?: TokenUsage; usage?: TokenUsage } | null | undefined,
): { input: number; output: number; total: number } {
  const u: TokenUsage = result?.usage || result?.totalUsage || {};
  const input = u.inputTokens ?? u.promptTokens ?? 0;
  const output = u.outputTokens ?? u.completionTokens ?? 0;
  const total = u.totalTokens ?? (input + output);
  return { input, output, total };
}

// Aggregate AI SDK 7 per-step performance stats into one compact block for the
// /debug record: total model wait, total step time (model + tool execution),
// per-tool execution ms (call ids mapped to tool names via each step's
// toolCalls), and the final step's effective output tokens/sec. Returns
// undefined when the result carries no performance data (foreign fixtures,
// mocks) — the record then simply omits the field. Pure: shaped object in, no
// `ai` import (this file's invariant).
export function perfOf(result: any): { modelMs: number; stepMs: number; toolMs?: Record<string, number>; tokensPerSec?: number } | undefined {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  let found = false;
  let modelMs = 0;
  let stepMs = 0;
  const toolMs: Record<string, number> = {};
  for (const s of steps) {
    const p = s?.performance;
    if (!p) continue;
    found = true;
    if (Number.isFinite(p.responseTimeMs)) modelMs += p.responseTimeMs;
    if (Number.isFinite(p.stepTimeMs)) stepMs += p.stepTimeMs;
    for (const [callId, ms] of Object.entries(p.toolExecutionMs || {})) {
      if (!Number.isFinite(ms)) continue;
      const name = (s.toolCalls || []).find((c: any) => c?.toolCallId === callId)?.toolName || callId;
      toolMs[name] = (toolMs[name] || 0) + (ms as number);
    }
  }
  if (!found) return undefined;
  const out: { modelMs: number; stepMs: number; toolMs?: Record<string, number>; tokensPerSec?: number } = {
    modelMs: Math.round(modelMs),
    stepMs: Math.round(stepMs),
  };
  if (Object.keys(toolMs).length) {
    out.toolMs = Object.fromEntries(Object.entries(toolMs).map(([k, v]) => [k, Math.round(v)]));
  }
  const tps = result?.finalStep?.performance?.effectiveOutputTokensPerSecond;
  if (Number.isFinite(tps) && tps > 0) out.tokensPerSec = Math.round(tps * 10) / 10;
  return out;
}

// Flatten the AI SDK result's warnings (accumulated across all steps in v7)
// into short strings for the success record. This is the live tripwire for the
// reasoning migration: a provider that IGNORES the top-level `reasoning` param
// emits an unsupported-setting warning here instead of silently thinking.
// undefined when there are none, so clean calls carry no extra field.
export function warningsOf(result: any): string[] | undefined {
  const list = Array.isArray(result?.warnings) ? result.warnings : [];
  const out = list.map((w: any) => {
    if (typeof w === 'string') return w;
    const head = [w?.type, w?.setting].filter(Boolean).join(':');
    const tail = w?.details || w?.message || '';
    return tail ? `${head || 'warning'} — ${tail}` : (head || JSON.stringify(w));
  }).filter(Boolean);
  return out.length ? out : undefined;
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
// because a host that answers with a status is reachable, and those should stay
// on transient retry rather than be masked by a silent failover to a different
// model (discussion #320). The ONE exception is isQuotaOrAuthError — the leg
// answered but cannot recover this call, so it is pulled OUT of the transient
// set and fails over instead of retrying a dead leg (#438).
//
// isUpstreamOverloaded is the inverse-shaped sibling: ADDED to the failover set
// but deliberately LEFT IN the transient set. An OpenRouter "ResourceExhausted"
// (#671) or an Anthropic 529 means the route is saturated right now which,
// unlike a quota cap, can clear in a second — so transient retry gets first
// crack on the chosen model, and only a persistent overload reaches failover.

// The AI SDK's built-in retry (generateText's default maxRetries: 2) throws
// AI_RetryError once its attempts are spent — a wrapper with NO statusCode,
// cause, or responseHeaders of its own. The real APICallError (with the 429
// status and the Retry-After header) lives in err.lastError / err.errors[].
// Every classifier below unwraps first, or a rate-limited/quota/overloaded
// call that the SDK already retried would classify as nothing at all and
// never fail over (PR #751 review). Duck-typed on the wrapper's fields, not
// RetryError.isInstance, so this file keeps its no-`ai`-import purity.
export function unwrapSdkError(err: ErrorLike): ErrorLike;
export function unwrapSdkError(err: ErrorLike | null | undefined): ErrorLike | null | undefined;
export function unwrapSdkError(err: ErrorLike | null | undefined): ErrorLike | null | undefined {
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

export function isTransient(err: ErrorLike | null | undefined): boolean {
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

export function isUnreachable(err: ErrorLike | null | undefined): boolean {
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

// The leg was refused in a way retrying the SAME model won't fix: a quota /
// usage-limit / billing rejection, or an auth failure. The host is UP, so this
// is NOT isUnreachable — but unlike a "slow down" 429 the leg can't recover, so
// withFailover treats it like host-down and switches to the backup (#438).
//
// Detected by MESSAGE because providers surface quota/auth differently and the
// AI SDK often flattens the status into the text; a bare 429 with no quota
// signature stays a plain transient rate-limit. "requires more credits" /
// "can only afford" are OpenRouter's per-request affordability 402, which
// carries no "insufficient"/"quota" token, so it is matched by text too.
const QUOTA_RE = /usage limit|quota|exceeded your current|insufficient[ _]?(quota|funds|credit|balance)|requires more credits|can only afford|upgrade for higher|out of credit|payment required/i;
// SUB/WAVE DJ Brain's monthly cap. It answers 429 with `error.code:
// "monthly_cap"` and a "Monthly … budget reached" / "Overage runaway ceiling"
// / "no cloud-voice budget" message — a wall that does not move until the
// calendar month rolls, so retrying the same leg is pure latency (measured:
// three attempts per pick, per link and per ident for the rest of the month).
// Ordinary "slow down" 429s carry none of these and stay transient.
const BRAIN_CAP_CODE = 'monthly_cap';
const BRAIN_CAP_RE = /monthly [\w-]+ budget reached|overage runaway ceiling reached|no cloud-voice budget/i;

// The upstream's machine-readable error code, when the SDK preserved the
// parsed (or raw) body. Preferred over message-sniffing because a reworded
// message must not silently re-enable the retries this exists to stop.
function upstreamErrorCode(err: ErrorLike): string {
  const body = err.data ?? err.responseBody;
  const parsed = typeof body === 'string'
    ? (() => { try { return JSON.parse(body); } catch { return null; } })()
    : body;
  const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : (typeof err.code === 'string' ? err.code : '');
}
const AUTH_RE = /invalid[ _]?api[ _]?key|incorrect[ _]?api[ _]?key|unauthorized|authentication (failed|error)|forbidden|api key (not|is|was) /i;

export function isQuotaOrAuthError(err: ErrorLike | null | undefined): boolean {
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
  // DJ Brain monthly cap — by code first, message second (see BRAIN_CAP_RE).
  if (upstreamErrorCode(err) === BRAIN_CAP_CODE) return true;
  if (BRAIN_CAP_RE.test(msg)) return true;
  return false;
}

// A reachable gateway relayed a SATURATED upstream: the host answered, but the
// route it fronts is at capacity. OpenRouter reports "Upstream error from
// <provider>: ResourceExhausted" (#671), Anthropic a 529 "Overloaded",
// Vertex/gRPC RESOURCE_EXHAUSTED.
//
// Neither a quota cap (the account has credit, so not isQuotaOrAuthError) nor a
// dead host (not isUnreachable) — a capacity blip that CAN clear on retry. So it
// STAYS in the transient set, letting withTransientRetry try the chosen model
// first, and withFailover adds it as a trigger so a persistent overload finally
// reaches the fallback rather than dying on the saturated route.
//
// Matched by message plus Anthropic's 529, and kept tight so it can't steal
// plain rate-limit 429s: only an explicit upstream/overload/exhausted phrase or
// a 529 qualifies, never a bare 503 or "rate limit exceeded, slow down".
const UPSTREAM_OVERLOAD_RE = /upstream error|resource[ _]?exhausted|overloaded|no instances?\b.*\bavailable|worker local total request limit/i;

export function isUpstreamOverloaded(err: ErrorLike | null | undefined): boolean {
  if (!err) return false;
  err = unwrapSdkError(err);
  const status = err.statusCode ?? err.status ?? err.cause?.statusCode ?? err.cause?.status;
  if (status === 529) return true; // Anthropic "Overloaded" — outside TRANSIENT_STATUS
  const msg = String(err.message || err.cause?.message || '');
  return UPSTREAM_OVERLOAD_RE.test(msg);
}

// A plain rate-limit 429 with no quota wording (#738) — a free-tier daily or
// per-minute request cap. This is the case isQuotaOrAuthError deliberately does
// NOT catch, so it stays isTransient and gets same-leg retries first; if those
// exhaust with the 429 still live, withFailover switches to the backup, since a
// request cap on the primary is exactly the "keep the station on air on a free
// tier" case and retrying the exhausted leg never recovers it.
//
// Deliberately NOT any bare 429: the status must also carry rate-limit wording
// or a Retry-After header. A self-hosted llama.cpp/vLLM box answering 429 on a
// momentary concurrency spike sends neither, and must stay a same-leg retry
// rather than silently switching the station onto a possibly-paid cloud
// fallback. Every provider #738 names does send the wording and/or header.
const RATE_LIMIT_RE = /rate.?limit|too many requests|requests? per (?:minute|day|hour)|\b[rt]p[mdh]\b/i;

export function isRateLimited(err: ErrorLike | null | undefined): boolean {
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
export function errReason(err: ErrorLike | null | undefined): string {
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
export function flattenToolCalls(result: { steps?: StepLike[] } | null | undefined): ToolCallSummary[] {
  return (result?.steps || []).flatMap((s) => {
    const results = s.toolResults || [];
    return (s.toolCalls || [])
      .filter((c) => c.toolName !== 'done')
      .map((c, i) => ({
        name: c.toolName,
        args: c.input ?? c.args ?? null,
        result: results[i]?.output ?? results[i]?.result ?? null,
      }));
  });
}

// ---------------------------------------------------------------------------
// Terminal single-turn collapse (issue #1157)
// ---------------------------------------------------------------------------
//
// Flatten an agent's chat window + discovery trail into ONE user message, so a
// tool loop that stalled can be finished by the single-turn forced-tool path
// (objectViaToolCall's `emit`) instead of yet another multi-turn continuation.
//
// The fix is the SHAPE, not more forcing. llama.cpp / LM Studio running
// Hermes-class models answer the terminal `done` step in prose no matter what
// `tool_choice` says (#1157: `tools:[done]` + `tool_choice:'required'` out,
// `tool_calls: []` + `finish_reason:'stop'` back, on both LM Studio and a bare
// `llama-server --jinja`) — yet the same backend and model call a forced tool
// reliably from a single user prompt, which is why the stateless pool picker
// keeps working for those operators while the agent path does not. GLM's "keeps
// declining once it has declined in this conversation" is the same thing.
//
// The findings block keeps the answer honest: the discovery tools' results are
// the only place real candidate ids exist, and dropping them leaves a cornered
// model able only to fabricate one. Truncation is per-result then whole-block,
// both announced in the text — a clipped candidate list costs at worst a pick
// from a shorter menu, and the caller's nearestId/repickFromSeen salvage still
// covers a mangled id as it does for every other branch of the cascade.

export interface TerminalMessageLike {
  role?: string;
  content?: unknown;
}

// Deliberately generous: this is a last resort before falling back to the pool
// picker, so the risk of a slightly long prompt beats the risk of starving the
// model of the candidate it should have picked. One discovery step (the
// COMMIT_AFTER_STEPS=1 gate) yields ~8 candidates, comfortably inside the block
// cap; the caps only bite on a model that fanned out before stalling.
const TERMINAL_HISTORY_TURNS = 6;
const TERMINAL_TURN_CHARS = 600;
const TERMINAL_ARGS_CHARS = 300;
const TERMINAL_FINDING_CHARS = 4000;
const TERMINAL_FINDINGS_TOTAL = 24000;

// Text of one ModelMessage. Providers hand us either a plain string or the
// parts array, where only `text` parts carry anything renderable — tool-call /
// tool-result parts are covered by the findings block, and replaying them here
// too would reintroduce the very turns this collapse exists to drop.
export function messageText(m: TerminalMessageLike | null | undefined): string {
  const c = m?.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  return c
    .map((p) => {
      const part = p as { type?: string; text?: unknown } | null;
      return part && part.type === 'text' && typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function jsonish(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function renderFindings(toolCalls: ToolCallSummary[] | null | undefined): string {
  // `done` is the schema-emit signal, never a discovery result — flattenToolCalls
  // already drops it, but this is also fed hand-built trails in tests.
  const calls = (toolCalls || []).filter((c) => c && c.name !== 'done');
  if (!calls.length) return '';
  const lines = ['What your tools already found:'];
  let spent = 0;
  let dropped = 0;
  for (const c of calls) {
    const body = String(clipText(jsonish(c.result), TERMINAL_FINDING_CHARS));
    if (!body) continue;
    if (spent && spent + body.length > TERMINAL_FINDINGS_TOTAL) {
      dropped++;
      continue;
    }
    spent += body.length;
    const args = String(clipText(jsonish(c.args), TERMINAL_ARGS_CHARS));
    lines.push(`${c.name ?? 'tool'}(${args}) returned:`);
    lines.push(body);
  }
  if (dropped) lines.push(`(${dropped} further tool result${dropped === 1 ? '' : 's'} omitted for length.)`);
  return lines.length > 1 ? lines.join('\n') : '';
}

export function renderTerminalPrompt(
  messages: TerminalMessageLike[] | null | undefined,
  toolCalls: ToolCallSummary[] | null | undefined,
): string {
  const turns = (messages || [])
    .map((m) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', text: messageText(m) }))
    .filter((t) => t.text);
  // The last user turn IS the task ("Pick the track to play next…"), so it is
  // restated on its own at the end — nearest the answer, and out of a history
  // block the model might read as already-handled. Every other turn is history,
  // including any assistant turns AFTER the task turn (djAgent's windows end on
  // the user event turn today, but a trailing turn is context, not droppable).
  const lastUserIdx = turns.map((t) => t.role).lastIndexOf('user');
  const task = lastUserIdx >= 0 ? turns[lastUserIdx].text : '';
  const history = (lastUserIdx >= 0 ? [...turns.slice(0, lastUserIdx), ...turns.slice(lastUserIdx + 1)] : turns)
    .slice(-TERMINAL_HISTORY_TURNS);

  const out: string[] = [];
  if (history.length) {
    out.push('Earlier in this session:');
    for (const t of history) out.push(`${t.role}: ${String(clipText(t.text, TERMINAL_TURN_CHARS))}`);
    out.push('');
  }
  const findings = renderFindings(toolCalls);
  if (findings) {
    out.push(findings);
    out.push('');
  }
  if (task) {
    out.push('Your task:');
    out.push(task);
    out.push('');
  }
  out.push(findings
    ? 'Answer now, in one step, using only what is above — do not invent ids, titles or results that do not appear in it.'
    : 'Answer now, in one step.');
  return out.join('\n');
}

// Pull diagnostic info off an AI SDK structured-output error. When the model
// emits something but the SDK can't parse it into the schema, the raw text
// lives on err.text (and the original cause on err.cause). Without this, the
// failure record only carries err.message — useless for "WHY didn't it parse?"
// triage. Best-effort: every field is optional, missing ones are skipped.
export function failureDiagnostics(err: ErrorLike | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof err?.text === 'string') out.responseText = err.text;
  if (err?.finishReason) out.finishReason = err.finishReason;
  if (err?.usage) out.usage = usageOf({ usage: err.usage as TokenUsage });
  if (err?.cause?.message && err.cause.message !== err.message) {
    out.causeMessage = err.cause.message;
  }
  // The agent loop's partial steps before the final-output failure — same
  // shape as the success-path toolCalls flatten, but with oversized string
  // results truncated: these entries live in the 120-entry /debug ring buffer
  // for the process lifetime, and a discovery tool's result (a full candidate
  // list) can run to tens of KB per step. The head is what triage needs.
  const clip = (v: unknown) => (typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}… [truncated ${v.length - 2000} chars]` : v);
  const steps = err?.response?.steps || err?.steps;
  if (Array.isArray(steps) && steps.length) {
    out.toolCalls = steps.flatMap((s) => {
      const results = s.toolResults || [];
      return (s.toolCalls || []).map((c: ToolCallLike, i: number) => ({
        name: c.toolName,
        args: c.input ?? c.args ?? null,
        result: clip(results[i]?.output ?? results[i]?.result ?? null),
      }));
    });
    out.steps = steps.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Near-miss id resolution
// ---------------------------------------------------------------------------

// Levenshtein distance capped at `cap` — bail as soon as a row's minimum
// exceeds the cap instead of filling the table; returns cap+1 for "farther".
function boundedLevenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// The runner-up must be at least this many edits farther than the best match
// for the best to be accepted. On random 22-char nanoids the id the model
// meant sits ~1-3 edits away while every OTHER candidate sits ~18+, so a real
// near-miss clears this margin trivially and a genuine tie refuses.
const NEAREST_ID_MARGIN = 4;

// Resolve a model-returned id that isn't in the candidate set to the candidate
// it almost certainly meant, or null when no single safe match exists. Small
// local models can't reproduce a high-entropy 22-char nanoid verbatim (#939 —
// swapped confusables, injected spaces, 2-3 edits at a time; glm-5.1 dropped a
// final char), so this is best-match-with-a-margin rather than a fixed tiny
// threshold:
//   1. prefix — one string is a prefix of the other, ≥ 12 chars shared and ≤ 3
//      chars difference (nanoid-style ids make a 12-char prefix collision
//      astronomically unlikely; 12 also keeps short ids from matching wildly).
//      Requires EXACTLY one candidate to match.
//   2. distance — score every candidate with a bounded Levenshtein; accept the
//      closest only when it's within a length-scaled cap (5 for 22-char ids,
//      tighter for short ones) AND clearly closer than the runner-up
//      (NEAREST_ID_MARGIN). Any ambiguity → null, the caller falls back to its
//      re-pick / stateless path rather than airing a coin-flip.
// Only ever consulted AFTER an exact-id lookup misses, so models that return
// clean ids never touch this path.
export function nearestId(id: string, candidateIds: Iterable<string>): string | null {
  if (!id || typeof id !== 'string') return null;
  const ids = [...candidateIds];
  const prefix = ids.filter((c) =>
    c !== id
    && Math.min(c.length, id.length) >= 12
    && Math.abs(c.length - id.length) <= 3
    && (c.startsWith(id) || id.startsWith(c)));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) return null;
  // Accept cap scales with the returned id's length so a short string can't
  // fuzzy-match half the set; 22-char nanoids get the full cap of 5.
  const cap = Math.min(5, Math.max(1, Math.floor(id.length / 4)));
  // Distances only matter up to cap + margin: anything past that bound can
  // affect neither the accept test nor the margin test.
  const bound = cap + NEAREST_ID_MARGIN;
  let best: string | null = null;
  let bestDist = bound + 1;
  let secondDist = bound + 1;
  for (const c of ids) {
    if (c === id) continue;
    const d = boundedLevenshtein(c, id, bound);
    if (d < bestDist) {
      secondDist = bestDist;
      bestDist = d;
      best = c;
    } else if (d < secondDist) {
      secondDist = d;
    }
  }
  if (!best || bestDist > cap) return null;
  return secondDist - bestDist >= NEAREST_ID_MARGIN ? best : null;
}

// ---------------------------------------------------------------------------
// ElevenLabs model-family helpers
// ---------------------------------------------------------------------------

// True for ElevenLabs' eleven_v3* family (v3, v3_preview, …). v3 renders
// bracketed audio tags ([laughs]/[sighs]) as expressive cues and — unlike the
// v2 families — accepts only a discrete `stability` (see snapV3Stability). Lives
// here (not the prompt layer) so both djSystem's tag hint and cloud-speech's
// stability snap share one rule without a prompts→speech import cycle. Pure +
// unit-pinned in scripts/llm-pure.test.ts.
export function isElevenLabsV3(model: string): boolean {
  return /^eleven[_-]?v3/i.test(model || '');
}

// Fish's natural-language bracket cues are an S2.1 capability. Custom model
// strings remain supported, but fail closed unless they identify that family.
export function isFishS21Model(model: string): boolean {
  return /^s2[._-]?1(?:[._-]|$)/i.test(model || '');
}

export function cloudExpressionCueFamily(provider: string, model: string): 'fish-s21' | 'elevenlabs-v3' | null {
  if (provider === 'fish-audio' && isFishS21Model(model)) return 'fish-s21';
  if (provider === 'elevenlabs' && isElevenLabsV3(model)) return 'elevenlabs-v3';
  return null;
}

// eleven_v3 only accepts stability ∈ {0, 0.5, 1}; any other value 400s the
// request, dropping the segment to a local engine that reads v3 audio tags
// aloud as words (issue #915 review). Snap an arbitrary [0,1] slider value to
// the nearest allowed rung — ties round to 0.5 (v3's "Natural" default).
export function snapV3Stability(v: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return [0.5, 0, 1].reduce(
    (best, r) => (Math.abs(r - n) < Math.abs(best - n) ? r : best),
    0.5,
  );
}

// ---------------------------------------------------------------------------
// Malformed-nullable-field rescue (GLM/Zhipu observed, incl. the GLM Coding
// Plan)
// ---------------------------------------------------------------------------
//
// GLM doesn't send a well-formed value for a nullable field it has nothing to
// say — three distinct shapes observed on live traffic (2026-07-07), all
// producing a `done` tool call that is fully coherent in substance (a real
// reason, real content) but fails Zod validation on ONE field, which is
// indistinguishable from djAgent's perspective from the model never calling
// `done` at all — it silently misclassifies a valid call as "agent did not
// call the done tool before stopping" and burns a full recovery cascade on a
// call that already succeeded:
//   1. the literal STRING "null" instead of JSON null.
//   2. OMITTING THE KEY ENTIRELY (a `done` call with a coherent `reason`/
//      `air:false` but no `segment` key at all — not even null). `.nullable()`
//      accepts `null`, not `undefined` — Zod runs the field parser with
//      `undefined` for a genuinely-missing key, same as an explicit
//      `undefined` value, and this rejects same as case 1.
//   3. DOUBLE-ENCODING a nested object as a JSON STRING — e.g.
//      `segment: "{\"kind\":\"now-playing-dig\",...}"` instead of the real
//      nested object.

// The coercion is applied at the OBJECT level (one z.preprocess wrapping the
// whole payload schema), never per-field. That placement is load-bearing: the
// AI SDK renders tool inputSchemas with z.toJSONSchema(…, { io: 'input' })
// (zod4Schema in @ai-sdk/provider-utils), and a per-field z.preprocess pipe
// accepts `undefined` on its input side — so wrapping a field DROPS IT FROM
// THE PARENT'S `required` ARRAY in the schema every provider sees, silently
// inviting well-behaved models to omit `say`/`transition`/`segment` (fewer
// spoken links, dropped segments) to fix a malformation only GLM exhibits. A
// top-level preprocess renders with the full `required` array intact (pinned
// in llm-pure.test.ts), so the wire schema is byte-identical to the plain
// object's.

// Schema-driven payload repair: walks `schema.shape` and coerces each
// observed malformed shape on the raw value BEFORE validation —
//   - a nullable field sent as the STRING "null", or omitted → real null
//   - an object/array field double-encoded as a JSON STRING → parsed, then
//     recursed into (so a nested nullable like segment.sfx is repaired too)
// Deliberately narrow — exact matches / a targeted parse attempt only, no
// guessing at other malformed spellings that haven't been observed. The
// JSON-string rescue only fires for OBJECT/ARRAY fields: a plain string
// field's genuine value could coincidentally look like JSON (a bare
// number/boolean/quoted word), and re-parsing THAT would corrupt it.
export function coerceModelPayload(raw: unknown, schema: z.ZodObject<z.ZodRawShape>): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodTypeAny][]) {
    let v = out[key];
    if ((v === 'null' || v === undefined) && field.safeParse(null).success) {
      out[key] = null;
      continue;
    }
    if (v === undefined) continue; // missing non-nullable key — modelTolerant's fallbacks handle it
    // See through Nullable/Optional wrappers to the core type (.describe()
    // returns the same class, so it needs no unwrapping).
    let core: z.ZodTypeAny = field;
    while (core instanceof z.ZodNullable || core instanceof z.ZodOptional) core = core.unwrap() as z.ZodTypeAny;
    if ((core instanceof z.ZodObject || core instanceof z.ZodArray) && typeof v === 'string') {
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object') v = parsed;
      } catch { /* not JSON — leave it, let normal validation reject it */ }
    }
    if (core instanceof z.ZodObject && v && typeof v === 'object' && !Array.isArray(v)) {
      v = coerceModelPayload(v, core);
    }
    out[key] = v;
  }
  return out;
}

// The schema wrapper call sites use: the plain object schema stays the single
// source of the wire contract (tool inputSchema / response_format), and this
// preprocess repairs GLM's malformed shapes just before validation — on every
// parse path (done-tool args, text salvage, djObject recovery) since the
// preprocess rides the schema itself.
//
// `objectFallbacks` handles a REQUIRED (non-nullable) object field — some
// providers (llama.cpp's peg-gemma4 tool serializer, issue #906) drop a
// nullable nested object's `properties` entirely, so a field like `segment`
// must stay non-nullable for them, yet a missing/malformed value still needs
// to degrade gracefully rather than throw (the whole point: a coherent `done`
// call must not be misclassified as "never called done"). After coercion,
// any listed field that still fails its own validation is replaced by its
// fallback. Only safe when the caller's consumption site already treats the
// placeholder as "nothing to do" — verify that before adding a field here.
// A field-level .catch() is NOT equivalent: it renders a visible `"default"`
// into the JSON schema and drops the field from `required` (same io:'input'
// trap as above).
//
// `onDiscard` fires when a fallback replaces a value that HAD content (not
// undefined/null/"null") — real model output is being thrown away, and the
// operator should be able to tell that apart from the model choosing silence.
// Callers pass a logger; this module stays side-effect-free.
export function modelTolerant<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  opts?: {
    objectFallbacks?: Record<string, unknown>;
    onDiscard?: (field: string, value: unknown) => void;
  },
) {
  return z.preprocess((raw) => {
    const coerced = coerceModelPayload(raw, schema) as Record<string, unknown>;
    if (opts?.objectFallbacks && coerced && typeof coerced === 'object' && !Array.isArray(coerced)) {
      for (const [key, fallback] of Object.entries(opts.objectFallbacks)) {
        const fieldSchema: z.ZodTypeAny | undefined = schema.shape[key] as z.ZodTypeAny | undefined;
        if (!fieldSchema || fieldSchema.safeParse(coerced[key]).success) continue;
        const v = coerced[key];
        if (opts.onDiscard && v !== undefined && v !== null && v !== 'null') opts.onDiscard(key, v);
        coerced[key] = fallback;
      }
    }
    return coerced;
  }, schema);
}

// Strip every `description` key from a JSON-Schema-shaped value, recursively.
// z.toJSONSchema() carries every .describe() through verbatim, and several
// schemas here (the picker's `transition`) run to hundreds of words, since that
// prose is the primary channel for coaching the model on the native/tool-forced
// paths. In schemaHint's recovery prompt it would bloat the retry's token count
// for every caller — and that prompt needs only the STRUCTURE (field names,
// types, required-ness, enums) to stop the model guessing at keys, since the
// coaching prose already rides in the system/prompt text alongside it.
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'description') continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}

// Best-effort JSON Schema for a Zod object, embedded in djObject's free-text
// recovery prompt so that retry is self-describing regardless of what the
// caller's own system/prompt text happens to restate. Every OTHER structured-
// output path conveys the schema to the model via a real provider channel —
// native Output.object's response_format, or a forced tool's inputSchema — but
// the recovery path is plain generateText with no schema attached at all, so
// a model that doesn't already have the exact required keys memorised from
// prose (observed: GLM omitting `reason`/`say` — issue triaged 2026-07-07)
// has nothing to go on. Swallows conversion failures (never let a schema this
// can't render block the retry it's meant to help).
export function schemaHint(schema: z.ZodTypeAny): string | null {
  try {
    return JSON.stringify(stripDescriptions(z.toJSONSchema(schema)));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lenient text caps for model-generated free-text fields
// ---------------------------------------------------------------------------

// Trim `s` to at most `max` characters, on a word boundary where that keeps
// most of the budget (else a hard char cut, so a single very long token can't
// defeat the cap). Non-strings pass through untouched — the caller's schema
// decides how to treat them.
//
// The point: a `.max(N)` cap on a model-generated free-text field is a NUDGE,
// not a hard contract — LLMs can't count characters and no provider enforces
// `maxLength` via decoding, so a one-sentence field landing a few chars over
// must not throw and discard the whole structured object (a 207-char programme
// `angle` vs a 200 cap sank the entire episode plan). Keep the `.max(N)` in the
// schema (it still advertises brevity to the model on every path) and CLIP the
// overflow before validation with a TOP-LEVEL z.preprocess over the plain
// object — the same object-level placement modelTolerant uses, and for the same
// reason: a per-field preprocess/`.catch()` silently drops the field from the
// parent's `required` array under io:'input' (see coerceModelPayload's note;
// pinned in llm-pure.test.ts). Callers walk their own known text fields and
// apply this in that preprocess.
export function clipText(s: unknown, max: number): unknown {
  if (typeof s !== 'string' || s.length <= max) return s;
  const cut = s.slice(0, max);
  const onWord = cut.replace(/\s+\S*$/, '');
  return (onWord.length >= max * 0.6 ? onWord : cut).trim();
}

// A persona `soul` gets SOUL_MAX (2000) because it is injected into every
// free-text call for THAT persona — the seat it was written for. Two consumers
// inline a soul where that reasoning doesn't hold and clamp to this instead:
//
//   - the multi-voice cast blocks (prompts/banter.ts, prompts/programme.ts) —
//     one entry per cast member, and the block exists to say who is in the room,
//     not to hand each of them a character document;
//   - the cloud-TTS delivery hint (speech/cloud-speech.ts) — rebuilt on EVERY
//     spoken line, and it only steers tone and pacing, so backstory enlarges
//     each request without changing the read.
//
// Both want the opening sketch, which is where operators put the voice.
// Whitespace is collapsed because a soul is multi-line and the cast blocks are
// one bullet per speaker; the ellipsis marks the sketch as abridged rather than
// reading as a full stop.
export const SOUL_BRIEF_MAX = 320;
export function soulBrief(soul: unknown, max: number = SOUL_BRIEF_MAX): string {
  const s = String(soul ?? '').trim().replace(/\s+/g, ' ');
  if (s.length <= max) return s;
  return `${String(clipText(s, max)).replace(/[,;:.]+$/, '')}…`;
}
