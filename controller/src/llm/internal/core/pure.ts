// Pure, side-effect-free LLM helpers — the unit-test seam
// (scripts/llm-pure.test.ts). No imports from `ai`, `settings` or `fs`; zod is
// the one allowed dependency. Keep it that way.

import { z } from 'zod';

// Duck-typed union of Error, AI SDK APICallError and the AI_RetryError wrapper.
// Every field is optional and narrowed before use.
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
  // Parsed/raw upstream error body, carrying the machine-readable `error.code`.
  data?: unknown;
  responseBody?: unknown;
  // Diagnostics fields truncationError attaches / failureDiagnostics reads.
  text?: unknown;
  finishReason?: unknown;
  usage?: unknown;
  steps?: unknown;
  response?: { steps?: unknown; messages?: unknown };
}

// Providers populate different subsets (a local Ollama box often omits them
// entirely), so every field is optional.
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

// One step's tool call / result off an AI SDK agent result. The
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

// Reasoning is suppressed at the provider layer when `llm.reasoning` is off;
// leftover <think> tags are stripped here defensively.
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>\s*/gi;
const CLOSE_THINK_RE = /<\/think>/i;
const ANY_THINK_TAG_RE = /<\/?think>/gi;

function normSeg(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Harmony / channel reasoning (gpt-oss, Gemma-4). Keep only the FINAL channel's
// message; with no final channel the whole reply is scaffolding. Some llama.cpp
// builds omit the trailing pipe, hence the optional `|` before `>`.
const FINAL_CHANNEL_RE = /<\|channel\|?>\s*final\s*<\|message\|?>/gi;
const ANY_CHANNEL_OPEN_RE = /<\|channel\|?>/i;
const HARMONY_TOKENS_RE = /<\|(?:start|end|return|message|channel)\|?>/gi;

export function stripThinking(s: string): string {
  if (!s || typeof s !== 'string') return s;
  let t = s.replace(THINK_TAG_RE, '');
  // Stray closing </think> with no opener: one close tag is a leak with the
  // answer after it (keep the LAST segment); three or more, or a repeat, is a
  // runaway loop whose tail is truncated (keep the FIRST).
  if (CLOSE_THINK_RE.test(t)) {
    const segs = t.split(/<\/think>/i).map((x) => x.trim()).filter(Boolean);
    if (segs.length) {
      const norm = segs.map(normSeg);
      const hasRepeat = norm.some((v, i) => norm.indexOf(v) !== i);
      t = segs.length >= 3 || hasRepeat ? segs[0] : segs[segs.length - 1];
    }
  }
  // Unterminated opener (#947): everything from it on is trapped reasoning.
  const openThink = t.search(/<think>/i);
  if (openThink !== -1) t = t.slice(0, openThink);
  let lastFinalEnd = -1;
  for (const m of t.matchAll(FINAL_CHANNEL_RE)) {
    lastFinalEnd = (m.index ?? 0) + m[0].length;
  }
  if (lastFinalEnd !== -1) {
    t = t.slice(lastFinalEnd);
  } else {
    const open = t.search(ANY_CHANNEL_OPEN_RE);
    if (open !== -1) t = t.slice(0, open);
  }
  // No stray think tag or harmony control token ever reaches TTS/booth.
  return t.replace(ANY_THINK_TAG_RE, '').replace(HARMONY_TOKENS_RE, '').trim();
}

// A 'length' finish means the reply was cut at the output-token cap, which for
// DJ free text is always a runaway generation (#947). Returns the Error to
// throw, or null when the reply finished normally. The message carries no digits
// so the transient/failover classifiers can't read it as a status.
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

// Pull a JSON object out of a free-text reply, for djObject's recovery path.
export function extractJson(s: string): string {
  if (!s) throw new Error('empty model response');
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model response');
  return t.slice(start, end + 1);
}

// Normalise the AI SDK usage block. In v7 `usage` already sums across steps;
// `totalUsage` is the deprecated alias, kept for pre-v7-shaped fixtures.
export function usageOf(
  result: { totalUsage?: TokenUsage; usage?: TokenUsage } | null | undefined,
): { input: number; output: number; total: number } {
  const u: TokenUsage = result?.usage || result?.totalUsage || {};
  const input = u.inputTokens ?? u.promptTokens ?? 0;
  const output = u.outputTokens ?? u.completionTokens ?? 0;
  const total = u.totalTokens ?? (input + output);
  return { input, output, total };
}

// Per-step performance stats aggregated for /debug, in ms. undefined when the
// result carries none, so the record omits the field.
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

// Result warnings flattened for the success record — the tripwire for a provider
// that ignores the `reasoning` param. undefined when there are none.
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

// Daily LLM token budget: 'soft' drops to the cheap picker and mutes optional
// segments, 'hard' stops calling the model at all. Caller owns count and cap.
// cap <= 0 disables (the default); softPct of 0 or 100 disables the soft tier.
export function budgetMode(
  { used, cap, softPct }: { used: number; cap: number; softPct: number },
): 'normal' | 'soft' | 'hard' {
  if (!Number.isFinite(cap) || cap <= 0) return 'normal';
  if (used >= cap) return 'hard';
  if (softPct > 0 && softPct < 100 && used >= cap * (softPct / 100)) return 'soft';
  return 'normal';
}

// Four classifiers gating two recovery mechanisms:
//   isTransient          → retry the SAME leg (5xx / plain 429 / socket).
//   isUnreachable        → fail over to the BACKUP leg (host is down). Strict
//                          subset of isTransient, EXCLUDING 408/425/429/5xx —
//                          a host that answers with a status is reachable (#320).
//   isQuotaOrAuthError   → fail over; host up but refusing this leg, so retrying
//                          it is futile. Pulled OUT of the transient set (#438).
//   isUpstreamOverloaded → fail over, but deliberately LEFT IN the transient set
//                          (#671): a saturated route can clear in a second, so
//                          same-leg retry gets first crack and only a persistent
//                          overload reaches failover.

// AI_RetryError is a wrapper with no statusCode/cause/responseHeaders of its
// own; the real APICallError lives in err.lastError / err.errors[]. Every
// classifier must unwrap first or an SDK-retried call classifies as nothing and
// never fails over. Duck-typed to keep this file `ai`-free.
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
  // Permanent for this leg — let it propagate to withFailover (#438). A plain
  // rate-limit 429 with no quota/auth signature stays transient below.
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

// Host down, not merely busy. withDeadline's AgentDeadlineError deliberately
// does NOT match — a model that overthinks is not a host that is down.
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

// Quota / billing rejection or auth failure: host up but this leg cannot
// recover, so failover treats it like host-down (#438). Detected by MESSAGE
// because providers surface it differently; a bare 429 with no quota signature
// stays a plain transient rate-limit.
const QUOTA_RE = /usage limit|quota|exceeded your current|insufficient[ _]?(quota|funds|credit|balance)|requires more credits|can only afford|upgrade for higher|out of credit|payment required/i;
// DJ Brain's monthly cap: a 429 that does not move until the month rolls.
const BRAIN_CAP_CODE = 'monthly_cap';
const BRAIN_CAP_RE = /monthly [\w-]+ budget reached|overage runaway ceiling reached|no cloud-voice budget/i;

// The upstream's machine-readable error code, when the SDK preserved the body.
// Preferred over message-sniffing, which a reword would defeat.
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
  if (status === 401 || status === 403) return true;
  // A bare 429 is deliberately NOT enough — only one whose message names a
  // quota, via QUOTA_RE below.
  if (status === 402) return true;
  const msg = String(err.message || err.cause?.message || '');
  if (AUTH_RE.test(msg)) return true;
  if (QUOTA_RE.test(msg)) return true;
  // Monthly cap: by code first, message second.
  if (upstreamErrorCode(err) === BRAIN_CAP_CODE) return true;
  if (BRAIN_CAP_RE.test(msg)) return true;
  return false;
}

// A reachable gateway relayed a SATURATED upstream (#671). Kept tight so it
// can't steal plain rate-limit 429s: an explicit overload phrase or a 529 only.
const UPSTREAM_OVERLOAD_RE = /upstream error|resource[ _]?exhausted|overloaded|no instances?\b.*\bavailable|worker local total request limit/i;

export function isUpstreamOverloaded(err: ErrorLike | null | undefined): boolean {
  if (!err) return false;
  err = unwrapSdkError(err);
  const status = err.statusCode ?? err.status ?? err.cause?.statusCode ?? err.cause?.status;
  if (status === 529) return true; // Anthropic "Overloaded" — outside TRANSIENT_STATUS
  const msg = String(err.message || err.cause?.message || '');
  return UPSTREAM_OVERLOAD_RE.test(msg);
}

// A plain rate-limit 429 with no quota wording (#738): stays transient, so
// same-leg retries go first. Deliberately NOT any bare 429 — it must also carry
// rate-limit wording or a Retry-After header, so a self-hosted box answering 429
// on a concurrency spike doesn't switch to a paid cloud fallback.
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

// Short reason string for logs. A transport failure surfaces as undici's opaque
// `TypeError: fetch failed` with the real errno on err.cause.code, not err.code.
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

// Flatten a tool-loop result's discovery trail for /debug. Excludes the
// synthetic `done` tool — that is the schema-emit signal, not a discovery action.
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

// Terminal single-turn collapse (#1157): flatten an agent's chat window +
// discovery trail into ONE user message so a stalled tool loop can be finished
// by the single-turn forced-tool path. The findings block is load-bearing — the
// discovery results are the only place real candidate ids exist.

export interface TerminalMessageLike {
  role?: string;
  content?: unknown;
}

// Deliberately generous: this is the last resort before the pool picker, so a
// long prompt beats starving the model of the candidate it should have picked.
const TERMINAL_HISTORY_TURNS = 6;
const TERMINAL_TURN_CHARS = 600;
const TERMINAL_ARGS_CHARS = 300;
const TERMINAL_FINDING_CHARS = 4000;
const TERMINAL_FINDINGS_TOTAL = 24000;

// Text of one ModelMessage. Only `text` parts count — tool-call/result parts are
// covered by the findings block, and replaying them would reintroduce the turns
// this collapse exists to drop.
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
  // flattenToolCalls already drops `done`, but this is also fed hand-built trails.
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
  // The last user turn IS the task, so it is restated on its own at the end,
  // out of a history block the model might read as already-handled.
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

// Diagnostic info off an AI SDK structured-output error. Best-effort: every
// field is optional and missing ones are skipped.
export function failureDiagnostics(err: ErrorLike | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof err?.text === 'string') out.responseText = err.text;
  if (err?.finishReason) out.finishReason = err.finishReason;
  if (err?.usage) out.usage = usageOf({ usage: err.usage as TokenUsage });
  if (err?.cause?.message && err.cause.message !== err.message) {
    out.causeMessage = err.cause.message;
  }
  // Oversized string results are truncated: these live in the 120-entry /debug
  // ring for the process lifetime and one result can run to tens of KB.
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

// Levenshtein distance capped at `cap`; returns cap+1 for "farther".
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

// How many edits farther the runner-up must be for the best match to be
// accepted. On 22-char nanoids the intended id sits ~1-3 edits away and every
// other candidate ~18+, so a real near-miss clears it and a tie refuses.
const NEAREST_ID_MARGIN = 4;

// Resolve a model-returned id that is not in the candidate set to the one it
// meant, or null when no single safe match exists (#939 — small local models
// can't reproduce a 22-char nanoid verbatim). Prefix match first (exactly one
// candidate), then bounded Levenshtein within a length-scaled cap and clearly
// closer than the runner-up. Any ambiguity returns null and the caller falls
// back. Only consulted after an exact-id lookup misses.
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
  // Cap scales with the id's length so a short string can't fuzzy-match half
  // the set; 22-char nanoids get the full cap of 5.
  const cap = Math.min(5, Math.max(1, Math.floor(id.length / 4)));
  // Distances past cap + margin can affect neither the accept nor margin test.
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

// ElevenLabs eleven_v3* family: bracketed audio tags render as expressive cues,
// and `stability` is discrete (snapV3Stability). Lives here so djSystem's tag
// hint and cloud-speech's snap share one rule without an import cycle.
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
// request. Snap a [0,1] slider value to the nearest rung; ties round to 0.5.
export function snapV3Stability(v: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return [0.5, 0, 1].reduce(
    (best, r) => (Math.abs(r - n) < Math.abs(best - n) ? r : best),
    0.5,
  );
}

// Malformed-payload rescue (observed on GLM/Zhipu): a `done` call failing Zod on
// one field is indistinguishable from never calling `done`, so it burns the whole
// recovery cascade. Repairs two shapes before validation: a nullable field sent
// as the string "null" or omitted → real null, and an object/array field
// double-encoded as a JSON string → parsed, then recursed into. Deliberately
// narrow — the JSON-string rescue fires only for object/array fields, since a
// genuine string value can look like JSON.
//
// MUST be applied at the OBJECT level (one z.preprocess over the whole schema),
// never per-field: the AI SDK renders tool inputSchemas with io:'input', where a
// per-field preprocess accepts `undefined` and so drops the field from the
// parent's `required` array in the schema every provider sees.
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
    // See through Nullable/Optional wrappers to the core type.
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

// The schema wrapper call sites use: the plain object schema stays the wire
// contract, and this preprocess rides it so every parse path (done-tool args,
// text salvage, djObject recovery) gets the repair.
//
// `objectFallbacks` covers a REQUIRED object field — some providers drop a
// nullable nested object's `properties` entirely (#906), so such a field must
// stay non-nullable for them, yet a malformed value must degrade rather than
// throw. Only safe when the consumption site reads the placeholder as "nothing
// to do". A field-level .catch() is NOT equivalent: it drops the field from
// `required` under io:'input'.
//
// `onDiscard` fires when a fallback replaces a value that HAD content, so the
// operator can tell discarded output from the model choosing silence.
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

// z.toJSONSchema() carries every .describe() through verbatim and some run to
// hundreds of words; schemaHint's recovery prompt needs only the structure.
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

// JSON Schema for djObject's free-text recovery prompt, which is plain
// generateText with no schema on a provider channel. Swallows conversion
// failures rather than block the retry it exists to help.
export function schemaHint(schema: z.ZodTypeAny): string | null {
  try {
    return JSON.stringify(stripDescriptions(z.toJSONSchema(schema)));
  } catch {
    return null;
  }
}

// Trim `s` to at most `max` characters, on a word boundary where that keeps most
// of the budget (else a hard cut). Non-strings pass through untouched.
//
// A `.max(N)` on a model-generated field is a nudge, not a contract: a field a
// few chars over must not discard the whole object. Keep the `.max(N)` and clip
// the overflow from a TOP-LEVEL z.preprocess, same placement as modelTolerant.
export function clipText(s: unknown, max: number): unknown {
  if (typeof s !== 'string' || s.length <= max) return s;
  const cut = s.slice(0, max);
  const onWord = cut.replace(/\s+\S*$/, '');
  return (onWord.length >= max * 0.6 ? onWord : cut).trim();
}

// A persona `soul` gets SOUL_MAX (2000) where it is the seat's own prompt. Two
// consumers clamp to this shorter sketch instead: the multi-voice cast blocks
// (prompts/banter.ts, prompts/programme.ts) and the cloud-TTS delivery hint
// (speech/cloud-speech.ts). Whitespace is collapsed since a soul is multi-line.
export const SOUL_BRIEF_MAX = 320;
export function soulBrief(soul: unknown, max: number = SOUL_BRIEF_MAX): string {
  const s = String(soul ?? '').trim().replace(/\s+/g, ' ');
  if (s.length <= max) return s;
  return `${String(clipText(s, max)).replace(/[,;:.]+$/, '')}…`;
}
