// A cached /health poll — the periodic "probe an optional backend, cache
// whether it's up, expose it synchronously" pattern shared by the remote-TTS
// client (audio/remoteTts.ts) and the tts-heavy sidecar client
// (audio/ttsHeavyClient.ts). Both hand-rolled the same loop: probe once now,
// again on an interval, cache the result, and react only when it changes.
//
// This factory owns that lifecycle; the caller supplies the probe (which does
// the actual fetch + interpretation and MUST NOT throw — a failed probe returns
// the "unavailable" value) and an onChange side effect. The interval is always
// unref'd so a background poll never keeps the event loop alive on its own — one
// copy remembered to unref, the other didn't; centralising it fixes the drift.
//
// It is deliberately NOT used by the analyzer's backend probe (music/analyzer.ts):
// that one is a lazy resolve-once over MULTIPLE candidate URLs with capability
// flags and no periodic interval, so it doesn't share this shape.

export interface CachedHealthProbe<R> {
  // Probe once now, update the cached value, fire onChange if it changed, and
  // return the fresh value.
  refresh(): Promise<R>;
  // Start the periodic loop: one probe immediately, then every intervalMs.
  // Idempotent — a second call on the same probe is a no-op.
  start(): void;
  // The last probed value, read synchronously (what isAvailable() reads).
  get(): R;
}

export interface CachedHealthProbeOptions<R> {
  // Perform one probe. MUST NOT throw — return the "unavailable" value on any
  // network / timeout / parse failure, exactly as the callers collapse a miss.
  probe: () => Promise<R>;
  intervalMs: number;
  // Seed value before the first probe resolves; also the baseline the first
  // probe's change detection compares against.
  initial: R;
  // Fired only when a probe's result differs from the previous one, newest
  // first — where the callers' logging / consumer-push side effects live.
  onChange?: (next: R, prev: R) => void;
  // Equality for change detection. Defaults to Object.is (fine for a boolean
  // probe); the richer { available, meta } probe supplies its own.
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
