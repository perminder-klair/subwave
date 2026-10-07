// Bound response establishment by default; bodyDeadline keeps the unref'd timer
// armed through body consumption. Timeout rejects as AbortError; an outer signal
// can abort sooner. Clear timers on failures.

export interface FetchTimeoutInit extends RequestInit {
  timeoutMs: number;
  /** Keep the deadline armed over the body read, not just the fetch(). */
  bodyDeadline?: boolean;
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  { timeoutMs, bodyDeadline, signal, ...init }: FetchTimeoutInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (bodyDeadline) timer.unref?.();
  try {
    const res = await fetch(input, {
      ...init,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (bodyDeadline) return res; // timer stays armed; no-op once the body is consumed
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
