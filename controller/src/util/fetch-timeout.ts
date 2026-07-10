// fetch() with a request deadline — the one place the controller's
// AbortController + setTimeout(abort) + clearTimeout dance lives, replacing
// ~20 hand-rolled copies scattered across the audio / broadcast / music /
// routes / skills / mcp modules.
//
// Semantics match the copies it replaces: the timeout bounds ESTABLISHING the
// response (the fetch() call), and the timer is ALWAYS cleared in a finally —
// including when fetch throws. Several copies cleared it only on the success
// path (e.g. routes/public.ts, routes/onboarding.ts), leaving a timer armed for
// the full timeout on a network error; routing them through here fixes that.
//
// The caller reads the body (res.json()/.text()/.arrayBuffer()) AFTER this
// resolves, so the body drain is not itself bounded — exactly as before, since
// every copy cleared the timer around the fetch, not around the body read. A
// site that must keep the deadline armed across a streaming body (the capped
// analyzer download) keeps its own controller and does NOT use this helper.
//
// On timeout the underlying fetch rejects with an AbortError (DOMException
// name 'AbortError'), so call sites that special-case err.name === 'AbortError'
// keep working. Pass `signal` to compose an outer abort (a request-scoped
// cancel) with the timeout — whichever fires first aborts the fetch.

export interface FetchTimeoutInit extends RequestInit {
  timeoutMs: number;
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  { timeoutMs, signal, ...init }: FetchTimeoutInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
