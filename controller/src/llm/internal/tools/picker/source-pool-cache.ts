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
const pending = new Map<string, Promise<any[]>>();
let generation = 0;
export function clearPickerSourceCache(): void {
  generation++;
  sourceCache.clear();
  pending.clear();
}

export async function cachedPickerSource(key: string, read: () => Promise<any[]>): Promise<any[]> {
  const hit = sourceCache.get(key);
  if (hit && hit.until > Date.now()) return hit.rows;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const startedGeneration = generation;
  const promise = read().then(rows => {
    if (generation === startedGeneration) {
      if (sourceCache.size >= 128) sourceCache.delete(sourceCache.keys().next().value!);
      sourceCache.set(key, { rows, until: Date.now() + (rows.length ? 30 : 5) * 60_000 });
    }
    return rows;
  }).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
  pending.set(key, promise);
  return promise;
}

// An unprobed standard server source stays available. Once it has answered
// empty, don't spend a pass on it again until the short retry TTL expires.
export function pickerSourceAvailable(key: string): boolean {
  const hit = sourceCache.get(key);
  return !hit || hit.until <= Date.now() || hit.rows.length > 0;
}
