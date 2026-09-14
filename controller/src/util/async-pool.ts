// Generic async concurrency primitives; no project imports.

// Run `worker` over every item with at most `concurrency` in flight. Resolves in
// INPUT order. A worker that throws rejects the whole pool.
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results: R[] = new Array(n);
  if (n === 0) return results;
  // `cursor++` is atomic on the event loop, so two runners never share an index.
  let cursor = 0;
  const runners = Math.max(1, Math.min(Math.floor(concurrency) || 1, n));
  async function run(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= n) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: runners }, () => run()));
  return results;
}

// Memoise an async fn by key, caching the in-flight PROMISE so concurrent
// callers for one key share a single underlying call.
export function memoizeByKey<R>(
  fn: (key: string) => Promise<R>,
): (key: string) => Promise<R> {
  const cache = new Map<string, Promise<R>>();
  return (key: string): Promise<R> => {
    let p = cache.get(key);
    if (!p) {
      p = fn(key);
      cache.set(key, p);
    }
    return p;
  };
}
