// Tracks Spotify refused to play, on disk.
//
// WHY THIS EXISTS. Spotify removed `available_markets` and GET /markets in
// February 2026, and with nothing left to derive a market from, client.ts sends
// no `market` parameter at all — so the API never populates `is_playable` and
// map.ts's `isPlayable` is `true` for every track the station will ever see.
// Availability is therefore discoverable ONLY at play time, from librespot's
// `unavailable` event or a 403 on the play command.
//
// Before this file the knowledge died with the log line: onPushResolveFailed
// spliced the item out of `upcoming` and re-picked, writing the track id
// nowhere, so the picker offered the same dead track again on the next cycle.
// Measured on a real run: 212 consecutive unresolvable picks of one track, each
// costing an LLM call and a play command, with the auto playlist covering the
// air throughout.
//
// An entry EXPIRES (UNPLAYABLE_TTL_MS). A refusal is a statement about one
// account's licensing right now, not about the recording — catalogue deals
// lapse and return — so a permanent list would quietly shrink the library for
// good. The cost of the expiry is stated in docs/spotify-source.md: a track that
// comes back has been pruned from the tag DB meanwhile and is re-tagged.
//
// Modelled on hold-file.ts: atomic writes, NEVER throws, and no 0600 — this is
// not a credential. Like the rate-limit hold and the artist-genre cache it is
// deliberately absent from routes/backup.ts: restoring one account's market
// refusals onto another machine would silently remove music there.

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../../../util/atomic-file.js';
import { SPOTIFY_STATE_DIR } from './token-file.js';

export const SPOTIFY_UNPLAYABLE_PATH = path.join(SPOTIFY_STATE_DIR, 'unplayable.json');

// How long a refusal is believed. Long enough that a dead track is not retried
// every day, short enough that a licence coming back is eventually noticed.
export const UNPLAYABLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Bounded, for the same reason keyedMemo in reads.ts is: the key space is the
// operator's whole catalogue, and an unbounded map is a leak wearing a cache's
// clothes. Oldest-first eviction by `at`.
export const UNPLAYABLE_MAX = 2000;

export interface UnplayableEntry {
  /** ms epoch when the track was FIRST refused — what the expiry is measured from. */
  at: number;
  /** ms epoch of the most recent refusal. */
  lastAt: number;
  /** How many times it has been refused; a high count means something is re-picking it. */
  hits: number;
  title: string;
  artist: string;
  /** `unavailable`, `never started`, or Spotify's own 403 message. */
  reason: string;
}

function parseEntry(raw: unknown): UnplayableEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const at = Number(o.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const lastAt = Number(o.lastAt);
  const hits = Number(o.hits);
  return {
    at,
    lastAt: Number.isFinite(lastAt) && lastAt > 0 ? lastAt : at,
    hits: Number.isFinite(hits) && hits > 0 ? Math.round(hits) : 1,
    title: typeof o.title === 'string' ? o.title : '',
    artist: typeof o.artist === 'string' ? o.artist : '',
    reason: typeof o.reason === 'string' ? o.reason : 'unavailable',
  };
}

// Every entry still inside its TTL. A file that cannot be read is an empty map,
// which is exactly the position the code was in before this file existed.
export function readUnplayable(file = SPOTIFY_UNPLAYABLE_PATH, now = Date.now()): Map<string, UnplayableEntry> {
  const out = new Map<string, UnplayableEntry>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = parseEntry(value);
    if (!entry) continue;
    if (now - entry.at >= UNPLAYABLE_TTL_MS) continue;  // expired: dropped on read
    out.set(id, entry);
  }
  return out;
}

function persist(map: Map<string, UnplayableEntry>, file: string): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    void writeFileAtomic(file, JSON.stringify(Object.fromEntries(map))).catch(() => {});
  } catch { /* a refusal we cannot persist costs the next restart, not this run */ }
}

// The live view. Module-global because the client and the pool are process
// singletons and this is asked once per row on every pick path; tests reset it
// through resetUnplayableCache().
let cache: Map<string, UnplayableEntry> | null = null;
let cacheFile = SPOTIFY_UNPLAYABLE_PATH;

function live(now: number): Map<string, UnplayableEntry> {
  if (!cache) cache = readUnplayable(cacheFile, now);
  return cache;
}

/** Test seam: point the store at a temp file and forget what was loaded. */
export function resetUnplayableCache(file = SPOTIFY_UNPLAYABLE_PATH): void {
  cacheFile = file;
  cache = null;
}

// Drop anything that aged out since the last read. An entry can expire without
// anything rewriting the file, so every reader sweeps first.
function sweep(now: number): Map<string, UnplayableEntry> {
  const map = live(now);
  for (const [id, entry] of map) {
    if (now - entry.at >= UNPLAYABLE_TTL_MS) map.delete(id);
  }
  return map;
}

export function isKnownUnplayable(id: string, now = Date.now()): boolean {
  const hit = live(now).get(id);
  if (!hit) return false;
  if (now - hit.at >= UNPLAYABLE_TTL_MS) {
    live(now).delete(id);
    return false;
  }
  return true;
}

/** The set every pick path filters against — one allocation per call, not per row. */
export function unplayableIds(now = Date.now()): ReadonlySet<string> {
  return new Set(sweep(now).keys());
}

export function unplayableCount(now = Date.now()): number {
  return sweep(now).size;
}

/**
 * Record a refusal. A repeat bumps `hits`/`lastAt` but NOT `at` — the expiry is
 * measured from the FIRST refusal, so a track being hammered cannot push its own
 * retry date out forever.
 */
export function markUnplayable(
  id: string,
  info: { title?: string | null; artist?: string | null; reason?: string } = {},
  now = Date.now(),
): UnplayableEntry {
  const map = live(now);
  const prev = map.get(id);
  const entry: UnplayableEntry = prev
    ? { ...prev, lastAt: now, hits: prev.hits + 1, reason: info.reason ?? prev.reason }
    : {
      at: now,
      lastAt: now,
      hits: 1,
      title: String(info.title ?? ''),
      artist: String(info.artist ?? ''),
      reason: info.reason ?? 'unavailable',
    };
  map.set(id, entry);
  // Evict oldest-first past the cap, by `at` rather than `lastAt`: the oldest
  // refusal is the one closest to expiring anyway.
  if (map.size > UNPLAYABLE_MAX) {
    const byAge = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [dropId] of byAge.slice(0, map.size - UNPLAYABLE_MAX)) map.delete(dropId);
  }
  persist(map, cacheFile);
  return entry;
}

// Forget every refusal. The operator's escape hatch, and the mirror of
// clearHold(). A missing file is success, not an error.
export function clearUnplayable(): number {
  const had = cache ? cache.size : readUnplayable(cacheFile).size;
  cache = new Map();
  try {
    rmSync(cacheFile, { force: true });
  } catch { /* nothing to clear, or nothing we can do about it */ }
  return had;
}

/** Newest refusal first — what the admin card lists. */
export function unplayableList(limit = 20, now = Date.now()): Array<UnplayableEntry & { id: string }> {
  return [...sweep(now).entries()]
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, Math.max(0, limit));
}
