// Runs `fn` immediately and then every `intervalMs`, pausing entirely while
// the tab is hidden and firing again the moment it returns to the foreground.
// Keeps background tabs from burning network/CPU on polls nobody can see.
// Returns a cleanup function.
export function pollWhileVisible(fn: () => void, intervalMs: number): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (id != null) return;
    fn();
    id = setInterval(fn, intervalMs);
  };
  const stop = () => {
    if (id != null) {
      clearInterval(id);
      id = null;
    }
  };
  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

// Network polls share one request at a time. Aborting on teardown also lets
// callers discard a response that arrives after their effect has been replaced.
export function pollAsyncWhileVisible(
  fn: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
): () => void {
  let stopped = false;
  let request: AbortController | null = null;
  const run = async () => {
    if (stopped || request) return;
    const current = new AbortController();
    request = current;
    const timeout = setTimeout(() => current.abort(), Math.max(15_000, intervalMs * 3));
    try {
      await fn(current.signal);
    } catch {
      // A failed or timed-out request can retry on the next visible tick.
    } finally {
      current.abort();
      clearTimeout(timeout);
      request = null;
    }
  };
  const stopPolling = pollWhileVisible(() => { void run(); }, intervalMs);
  return () => {
    stopped = true;
    stopPolling();
    request?.abort();
  };
}
