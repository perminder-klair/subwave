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
// By default the caller reads the body (res.json()/.text()/.arrayBuffer())
// AFTER this resolves, so the body drain is not itself bounded — matching the
// copies whose timer only wrapped the fetch() call. Copies whose finally sat at
// the end of the whole function had a deadline over the body read too; those
// sites pass `bodyDeadline: true`, which keeps the (unref'd) timer armed past
// resolution so a body read that outlives the deadline aborts instead of
// hanging on undici's ~300s default. A site that must stream a large body with
// its own cap (the capped analyzer download) keeps its own controller and does
// NOT use this helper.
//
// On timeout the underlying fetch rejects with an AbortError (DOMException
// name 'AbortError'), so call sites that special-case err.name === 'AbortError'
// keep working. Pass `signal` to compose an outer abort (a request-scoped
// cancel) with the timeout — whichever fires first aborts the fetch.

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
