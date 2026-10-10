// Coalesce concurrent reads. Never cache rejections or return stale values on errors.

export interface CachedAsync<T> {
  /** Cached value if fresh, else take a new one (coalescing concurrent calls). */
  get(): Promise<T>;
  /** The cached entry as-is, null when empty. NOT TTL-checked: an expired entry
   *  is still returned, so a caller that cares must compare `at` itself. */
  peek(): { value: T; at: number } | null;
  /** Drop the cached value; call after anything that changes what fn reports. */
  invalidate(): void;
}

export interface CachedAsyncOptions {
  ttlMs: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export function cachedAsync<T>(fn: () => Promise<T>, { ttlMs, now = Date.now }: CachedAsyncOptions): CachedAsync<T> {
  let entry: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;

  return {
    peek: () => entry,

    invalidate() {
      entry = null;
      // A take already in flight started before the change, so its result must
      // not become the cached entry; the `take === inFlight` guard drops it.
      inFlight = null;
    },

    get(): Promise<T> {
      if (entry && now() - entry.at < ttlMs) return Promise.resolve(entry.value);
      if (inFlight) return inFlight;

      const take = fn().then(
        value => {
          // Only the still-current take may publish; a reading that an
          // invalidate() overtook is returned but not cached.
          if (take === inFlight) {
            entry = { value, at: now() };
            inFlight = null;
          }
          return value;
        },
        err => {
          if (take === inFlight) inFlight = null;
          throw err;
        },
      );
      inFlight = take;
      return take;
    },
  };
}
