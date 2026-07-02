// Retry + deadline wrappers around a single LLM generation.
//
//   withTransientRetry — retries the SAME call on transient upstream blips.
//   withDeadline       — a hard wall-clock ceiling (Promise.race + AbortSignal).

import { isTransient, errReason } from './pure.js';

// Retry-After (seconds, or an HTTP-date) — RFC 9110 §10.2.3. Providers rate-
// limiting a 429 commonly tell the caller exactly how long to wait (OpenAI,
// Anthropic, Groq all send it); honouring it instead of a blind fixed delay
// (issue #738) means a same-leg retry actually lands after the window clears
// rather than guessing and burning the retry budget on another 429. Capped at
// 30s — same-leg retry exists to smooth a blip, not to block the DJ loop for a
// provider's full per-minute reset window; a longer wait should fail over.
const MAX_RETRY_AFTER_MS = 30_000;

export function retryAfterMs(err: any): number | null {
  const headers = err?.responseHeaders || err?.cause?.responseHeaders;
  const raw = headers?.['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

// Retry transient upstream failures (gateway timeouts, dropped sockets). Local
// Ollama — and anything proxying it — produces occasional 502/503/504 and TCP
// resets, especially on slow models with fat prompts. Without retry, one blip
// kills a station ID or hourly check (see issue #140). Two retries with
// jittered backoff is enough — beyond that the upstream is genuinely down and
// the failure should surface.
//
// Schema/parse failures and the agent's "did not call done" condition are NOT
// transient and bubble straight out — they need different recovery paths.
export async function withTransientRetry<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1500]; // ms — two retries, ~2s total budget
  let lastErr: any;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === delays.length) throw err;
      const jitter = Math.floor(Math.random() * 200);
      const wait = retryAfterMs(err) ?? (delays[attempt] + jitter);
      console.log(`[${kind}] transient upstream error — ${errReason(err)} — retrying in ${wait}ms (attempt ${attempt + 1}/${delays.length})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
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
