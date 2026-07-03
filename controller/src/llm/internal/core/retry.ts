// Retry + deadline wrappers around a single LLM generation.
//
//   withTransientRetry — retries the SAME call on transient upstream blips.
//   withDeadline       — a hard wall-clock ceiling (Promise.race + AbortSignal).

import { isTransient, errReason, unwrapSdkError } from './pure.js';

// Retry-After (seconds, or an HTTP-date) — RFC 9110 §10.2.3. Providers rate-
// limiting a 429 commonly tell the caller exactly how long to wait (OpenAI,
// Anthropic, Groq all send it); honouring it instead of a blind fixed delay
// (issue #738) means a same-leg retry actually lands after the window clears
// rather than guessing and burning the retry budget on another 429. Returns
// the RAW duration, uncapped — the caller compares it against
// MAX_RETRY_AFTER_MS and gives up on the leg (→ withFailover tries the backup)
// rather than clamping a per-day reset window down to something waitable.
// Unwraps AI_RetryError first: after the SDK's own retries the header lives on
// the wrapped APICallError, not the wrapper (PR #751 review). OpenAI also
// sends the ms-precision `retry-after-ms`; prefer it when present.
export function retryAfterMs(err: any): number | null {
  err = unwrapSdkError(err);
  const headers = err?.responseHeaders || err?.cause?.responseHeaders;
  if (!headers) return null;
  const rawMs = Number(headers['retry-after-ms']);
  if (Number.isFinite(rawMs) && rawMs > 0) return rawMs;
  const raw = headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

// The longest Retry-After worth sleeping on the SAME leg. Same-leg retry
// exists to smooth a blip, not to hold the DJ loop hostage for a provider's
// per-minute (or per-day) reset window — past this, the wait is the provider
// saying "come back much later", and the right move is to throw immediately so
// withFailover can try the configured backup leg NOW (issue #738). Kept well
// under the 45s default agent deadline (settings.llm.agentTimeoutMs) so an
// honoured wait can't blow the deadline and surface as AgentDeadlineError,
// which matches no failover classifier (PR #751 review).
export const MAX_RETRY_AFTER_MS = 15_000;

// Retry transient upstream failures (gateway timeouts, dropped sockets). Local
// Ollama — and anything proxying it — produces occasional 502/503/504 and TCP
// resets, especially on slow models with fat prompts. Without retry, one blip
// kills a station ID or hourly check (see issue #140). Two retries with
// jittered backoff is enough — beyond that the upstream is genuinely down and
// the failure should surface.
//
// A Retry-After header on the error overrides the fixed delay (jitter is kept
// so a fleet of callers released by the same header doesn't stampede back in
// sync); a header LONGER than MAX_RETRY_AFTER_MS aborts same-leg retry
// entirely — the error propagates to withFailover, which fails over to the
// backup leg instead of sleeping out the provider's reset window here.
//
// `signal` (optional, threaded from withDeadline by djAgent's runDeadlined)
// cuts the backoff sleep short and stops further attempts once the deadline
// has fired — without it the loop would sleep through the abort and launch a
// ghost attempt whose result nobody is waiting on.
//
// Schema/parse failures and the agent's "did not call done" condition are NOT
// transient and bubble straight out — they need different recovery paths.
export async function withTransientRetry<T>(
  kind: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const delays = [500, 1500]; // ms — two retries, ~2s total budget
  let lastErr: any;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === delays.length || signal?.aborted) throw err;
      const jitter = Math.floor(Math.random() * 200);
      const hinted = retryAfterMs(err);
      if (hinted != null && hinted > MAX_RETRY_AFTER_MS) {
        console.log(`[${kind}] provider asked to retry after ${Math.round(hinted / 1000)}s — beyond the ${MAX_RETRY_AFTER_MS / 1000}s same-leg budget, giving up on this leg`);
        throw err;
      }
      const wait = hinted != null ? hinted + jitter : delays[attempt] + jitter;
      console.log(`[${kind}] transient upstream error — ${errReason(err)} — retrying in ${wait}ms (attempt ${attempt + 1}/${delays.length})`);
      await sleep(wait, signal);
      if (signal?.aborted) throw lastErr;
    }
  }
  throw lastErr;
}

// setTimeout that ends early (resolving, not throwing — the aborted check
// after the sleep owns the exit) when the signal fires mid-wait.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

// Hard wall-clock ceiling on a single agent generation (including its
// transient retries). The `timeout` option on agent.generate() is NOT
// honoured by every transport — ai-sdk-ollama ignores it, so a
// reasoning-locked cloud model that never reaches the tool call just runs
// until its output budget is spent (observed at 60s+ per pick on
// minimax-m2.7:cloud while the caller believed it was capped at 22s). The
// race here is the guarantee; the AbortSignal is passed through as well so
// transports that DO support cancellation stop the request server-side
// instead of leaving it burning an inference slot.
//
// The deadline error deliberately does NOT look host-unreachable (its name
// matches neither isUnreachable's name checks nor its message regex): a model
// that overthinks past the deadline is not a host that's down, so the call
// must fall back to the caller's stateless path, not fail over to the backup
// leg on a different model.
export function withDeadline<T>(
  ms: number | undefined,
  label: string,
  fn: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!ms) return fn();
  const controller = new AbortController();
  let timer: any;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err: any = new Error(`${label} exceeded ${ms}ms deadline`);
      err.name = 'AgentDeadlineError';
      reject(err);
    }, ms);
  });
  // Promise.race attaches a reaction to every contender, so a late rejection
  // from `fn` after the deadline fires is observed (and ignored), never an
  // unhandledRejection.
  return Promise.race([fn(controller.signal), deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
