// A small in-process cache for the public lyrics endpoint. Structured lyric
// lookups authenticate to the station's Subsonic server, so a listener poll
// must never turn into an upstream request on every render. Promise entries
// deliberately coalesce concurrent misses as well as retaining recent values.

export interface LyricsCacheOptions {
  maxEntries?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T | null>;
}

export class BoundedLyricsCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;

  constructor(options: LyricsCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100;
    this.positiveTtlMs = options.positiveTtlMs ?? 30_000;
    this.negativeTtlMs = options.negativeTtlMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  async get(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      // Map order is our LRU order. Refreshing it here keeps frequently aired
      // tracks warm without allowing the cache to grow without bound.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.value;
    }
    if (existing) this.entries.delete(key);

    // Start with the short TTL so an in-flight failure is bounded too. It is
    // adjusted once the lookup resolves, while all concurrent callers await
    // this same promise rather than fanning out to Subsonic.
    const entry: CacheEntry<T> = {
      expiresAt: now + this.negativeTtlMs,
      value: Promise.resolve().then(load),
    };
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);

    try {
      const value = await entry.value;
      entry.expiresAt = this.now() + (value == null ? this.negativeTtlMs : this.positiveTtlMs);
      return value;
    } catch (err) {
      // Keep a failed lookup briefly as well. The endpoint still reports its
      // normal error, but a flaky upstream cannot be amplified by listeners.
      entry.expiresAt = this.now() + this.negativeTtlMs;
      throw err;
    }
  }
}
