// A picker tool is built afresh for each pick. Repeated calls can draw more
// candidates from the same source, but should not rerun its library-wide query.
// Cache the source pool, not collect()'s capped result: collect() must run again
// against the pick's updated seen set to surface additional eligible tracks.
export function cacheSourcePool<T extends object>(read: (key: string) => T): (key: string) => T {
  const pools = new Map<string, T>();
  return (key) => {
    const cached = pools.get(key);
    if (cached !== undefined) return cached;
    const rows = read(key);
    pools.set(key, rows);
    return rows;
  };
}

// Expensive server sources share a wide raw pool across picks, never the eight
// collected candidates. Short empty TTLs let newly available data recover.
const sourceCache = new Map<string, { until: number; rows: any[] }>();
// Only callers with the same cancellation lifetime may share unfinished I/O.
// Completed pools remain shared across every caller.
const pending = new Map<string, Map<AbortSignal | undefined, Promise<any[]>>>();
let generation = 0;
export function clearPickerSourceCache(): void {
  generation++;
  sourceCache.clear();
  pending.clear();
}

export async function cachedPickerSource(key: string, read: () => Promise<any[]>, availabilityKey?: string | (() => string | undefined), signal?: AbortSignal): Promise<any[]> {
  signal?.throwIfAborted();
  const hit = sourceCache.get(key);
  if (hit && hit.until > Date.now()) return hit.rows;
  const callers = pending.get(key) ?? new Map<AbortSignal | undefined, Promise<any[]>>();
  const inflight = callers.get(signal);
  if (inflight) return inflight;
  const startedGeneration = generation;
  const promise = read().then(rows => {
    signal?.throwIfAborted();
    if (generation === startedGeneration) {
      const entry = { rows, until: Date.now() + (rows.length ? 30 : 5) * 60_000 };
      const sourceKey = typeof availabilityKey === 'function' ? availabilityKey() : availabilityKey;
      for (const cacheKey of sourceKey ? [key, sourceKey] : [key]) {
        sourceCache.delete(cacheKey);
        sourceCache.set(cacheKey, entry);
        while (sourceCache.size > 128) sourceCache.delete(sourceCache.keys().next().value!);
      }
    }
    return rows;
  }).finally(() => {
    if (callers.get(signal) === promise) callers.delete(signal);
    if (!callers.size && pending.get(key) === callers) pending.delete(key);
  });
  callers.set(signal, promise);
  pending.set(key, callers);
  return promise;
}

// An unprobed standard server source stays available. Once it has answered
// empty, don't spend a pass on it again until the short retry TTL expires.
export function pickerSourceAvailable(key: string): boolean {
  const hit = sourceCache.get(key);
  return !hit || hit.until <= Date.now() || hit.rows.length > 0;
}
