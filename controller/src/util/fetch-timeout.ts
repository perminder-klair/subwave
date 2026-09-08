// fetch() with a request deadline: the one place the AbortController +
// setTimeout(abort) + clearTimeout dance lives. Never hand-roll another copy.
//
// The timeout bounds ESTABLISHING the response and the timer is always cleared,
// including when fetch throws. The body drain is NOT bounded by default; pass
// `bodyDeadline: true` to keep the (unref'd) timer armed past resolution so a
// slow body aborts instead of hanging on undici's ~300s default. A timeout
// rejects with an AbortError, so `err.name === 'AbortError'` call sites work.
// `signal` composes an outer abort with the timeout: whichever fires first wins.

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
