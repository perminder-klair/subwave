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
// Transient vs unreachable error classification
// ---------------------------------------------------------------------------
//
// Two overlapping classifiers gate two different recovery mechanisms:
//   isTransient  → withTransientRetry retries on the SAME leg (5xx/429/socket).
//   isUnreachable → withFailover switches to the BACKUP leg (host is DOWN).
// isUnreachable is a strict subset: it EXCLUDES 408/425/429/5xx, because a host
// that answers with a status is reachable — those stay with transient retry on
// the configured model rather than being masked by a silent failover to a
// different model (discussion #320).

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODE = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

export function isTransient(err: any): boolean {
  if (!err) return false;
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
