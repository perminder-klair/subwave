// The one shape for per-client limiter state (request cooldown/caps, the
// station-password throttle, likes, the admin strike counter, beacons). Every
// such map is keyed on clientIp(), which a client can influence, so three
// bounds are owned here rather than restated at each call site:
//
//   - KEY LENGTH: a key longer than MAX_KEY_LENGTH is replaced by its hash. A
//     hash, not a truncation: two long keys sharing a prefix must stay two
//     buckets, or one client could spend another's budget.
//   - KEY COUNT: at most `maxKeys` entries.
//   - EXPIRY BEFORE EVICTION: when the cap is reached, entries the caller's
//     `isLive` says are spent go first — judged against the window at that
//     moment, never against a stale snapshot of the record (a hit list is only
//     re-filtered when its own key calls again, so "has hits" alone never
//     expires). Only then, if live entries still fill more than a low-water
//     mark, are the least recently written dropped down to it — so the next
//     sweep is a tenth of the map away rather than one insert: amortised O(1)
//     per write, never a full scan per request.
//
// Evicting a LIVE entry forgets one client's counter. That is the fail-open
// direction every limiter here already takes for an unknown key, and a client
// able to fill the map can already present fresh keys, so it buys nothing new.
import { createHash } from 'node:crypto';

/** Longest key kept verbatim. Covers any textual IPv4/IPv6 address with room to spare. */
export const MAX_KEY_LENGTH = 64;

/** Fraction of `maxKeys` an over-full map is trimmed back to. */
const LOW_WATER = 0.9;

export function boundKey(key: unknown): string {
  const k = typeof key === 'string' ? key : String(key ?? '');
  if (k.length <= MAX_KEY_LENGTH) return k;
  return `#${createHash('sha256').update(k).digest('base64url')}`;
}

export interface BoundedKeyMapOptions<V> {
  maxKeys: number;
  /** False once the record no longer constrains its client at `now`. */
  isLive: (value: V, now: number) => boolean;
}

export class BoundedKeyMap<V> {
  // Insertion order IS recency: set() re-inserts, so the first key is always
  // the least recently written.
  private readonly map = new Map<string, V>();
  private readonly maxKeys: number;
  private readonly isLive: (value: V, now: number) => boolean;

  constructor({ maxKeys, isLive }: BoundedKeyMapOptions<V>) {
    this.maxKeys = Math.max(1, Math.floor(maxKeys));
    this.isLive = isLive;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: unknown): V | undefined {
    return this.map.get(boundKey(key));
  }

  set(key: unknown, value: V, now = Date.now()): void {
    const k = boundKey(key);
    this.map.delete(k);
    this.map.set(k, value);
    if (this.map.size > this.maxKeys) this.evict(k, now);
  }

  delete(key: unknown): boolean {
    return this.map.delete(boundKey(key));
  }

  clear(): void {
    this.map.clear();
  }

  private evict(keep: string, now: number): void {
    for (const [k, v] of this.map) {
      if (k !== keep && !this.isLive(v, now)) this.map.delete(k);
    }
    // Always land at the low-water mark, even when the sweep freed only a few:
    // a map hovering at the cap would otherwise sweep on every insert.
    const target = Math.max(1, Math.floor(this.maxKeys * LOW_WATER));
    for (const k of this.map.keys()) {
      if (this.map.size <= target) break;
      if (k !== keep) this.map.delete(k);
    }
  }
}
