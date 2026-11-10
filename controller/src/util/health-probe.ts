// Cached /health poll: probe an optional backend on an interval, cache whether
// it's up, expose it synchronously. Shared by audio/remoteTts.ts and
// audio/ttsHeavyClient.ts. The caller's probe MUST NOT throw (return the
// "unavailable" value instead), and the interval is always unref'd so a
// background poll never holds the event loop open.

export interface CachedHealthProbe<R> {
  // Probe once now, update the cache, fire onChange if it changed.
  refresh(): Promise<R>;
  // One probe immediately, then every intervalMs. Idempotent.
  start(): void;
  // The last probed value, read synchronously.
  get(): R;
}

export interface CachedHealthProbeOptions<R> {
  // One probe. MUST NOT throw: return the "unavailable" value on any failure.
  probe: () => Promise<R>;
  intervalMs: number;
  // Seed value, and the baseline the first probe's change detection compares against.
  initial: R;
  // Fired only when a probe's result differs from the previous one, newest first.
  onChange?: (next: R, prev: R) => void;
  // Change-detection equality; defaults to Object.is.
  equals?: (a: R, b: R) => boolean;
}

export function cachedHealthProbe<R>(opts: CachedHealthProbeOptions<R>): CachedHealthProbe<R> {
  const equals = opts.equals ?? Object.is;
  let current = opts.initial;
  let started = false;

  async function refresh(): Promise<R> {
    const next = await opts.probe();
    const prev = current;
    current = next;
    if (!equals(prev, next)) opts.onChange?.(next, prev);
    return next;
  }

  function start(): void {
    if (started) return;
    started = true;
    void refresh();
    const handle = setInterval(() => void refresh(), opts.intervalMs);
    handle.unref?.();
  }

  return { refresh, start, get: () => current };
}
