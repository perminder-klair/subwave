// Bound response establishment by default; bodyDeadline keeps the unref'd timer
// armed through body consumption. Timeout rejects as AbortError; an outer signal
// can abort sooner. Clear timers on failures.
//
// retryStaleSocket resends a request that died on a pooled keep-alive socket
// the server had already closed. A process that holds the event loop for a few
// seconds (a scoring pass, a bulk DB write) misses the server's idle close, so
// the next request goes out on the dead socket and fails within a millisecond
// with `UND_ERR_SOCKET: other side closed`, before any response. Undici retries
// only idempotent methods itself, so a POST is lost. Each such failure drops
// that socket from the pool, so a resend lands on another one or on a fresh
// connection; STALE_SOCKET_ATTEMPTS bounds it for a pool holding several dead
// sockets. Opt-in, and only for a request that is safe to send twice (the
// analyzer's compute endpoints) with a string body: the server may have read
// the request before the connection dropped.

export interface FetchTimeoutInit extends RequestInit {
  timeoutMs: number;
  /** Keep the deadline armed over the body read, not just the fetch(). */
  bodyDeadline?: boolean;
  /** Resend on a socket the server already closed (see the header). */
  retryStaleSocket?: boolean;
}

export const STALE_SOCKET_ATTEMPTS = 3;

const STALE_SOCKET_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

/** A fetch() that failed on a connection the other side closed, before a response. */
export function isStaleSocketError(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && STALE_SOCKET_CODES.has(code);
}

/** One line naming why a fetch() rejected: `fetch failed (UND_ERR_SOCKET: other side closed)`. */
export function describeFetchError(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const head = typeof e?.message === 'string' && e.message ? e.message : String(err);
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : '';
  const detail = typeof e?.cause?.message === 'string' ? e.cause.message : '';
  if (!code && !detail) return e?.name === 'AbortError' ? `${head} (timed out or aborted)` : head;
  return `${head} (${[code, detail].filter(Boolean).join(': ')})`;
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  { timeoutMs, bodyDeadline, retryStaleSocket, signal, ...init }: FetchTimeoutInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (bodyDeadline) timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const attempts = retryStaleSocket ? STALE_SOCKET_ATTEMPTS : 1;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(input, { ...init, signal: combined });
        if (bodyDeadline) return res; // timer stays armed; no-op once the body is consumed
        clearTimeout(timer);
        return res;
      } catch (err) {
        if (attempt >= attempts || combined.aborted || !isStaleSocketError(err)) throw err;
      }
    }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
