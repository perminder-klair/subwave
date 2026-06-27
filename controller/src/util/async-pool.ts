// Small async concurrency primitives, pulled out so they can be unit-pinned
// (scripts/tagger-perf.test.ts) — the library tagger's Phase-0 enrichment uses
// both. Kept generic + side-effect-free; no project imports.

// Run `worker` over every item with at most `concurrency` in flight at once,
// draining a shared cursor so each item is handled exactly once. Resolves to the
// results in INPUT order (not completion order). A worker that throws rejects the
// whole pool — callers that want per-item tolerance catch inside the worker.
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results: R[] = new Array(n);
  if (n === 0) return results;
  // `cursor++` is atomic on the single-threaded event loop, so two runners never
  // pull the same index.
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

// Memoise an async fn by key, caching the in-flight PROMISE (not just the
// resolved value) so concurrent callers for the same key share ONE underlying
// call instead of each firing their own before the first resolves. This is what
// keeps the enrichment pool from making one Last.fm request per track when many
// tracks share an artist.
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
