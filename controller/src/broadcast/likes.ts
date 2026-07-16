// Listener likes — the durable store behind the player's heart button (#991).
//
// One file, two jobs:
//   - persistence: every accepted like is a small record in state/likes.json,
//     carrying a slim track snapshot so the picker can feed favourites back
//     into the candidate pool without a Subsonic round-trip.
//   - accountless dedup: one like per apparent listener per AIRING. The
//     listener key is HMAC(secret, ip) — the raw IP is never stored, and the
//     secret is generated once and persisted alongside the records so dedup
//     survives restarts (unlike audience.ts, whose process-random salt only
//     needs same-day stability). Multiple listeners behind one NAT share a
//     key; this is lightweight dedup, not identity.
//
// Navidrome star write-back is NOT here — the route fires subsonic.star()
// itself; this module owns only the controller-side record.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

const STORE_FILE = join(config.stateDir, 'likes.json');
// Hard cap on stored records — oldest trimmed first. At a homelab station's
// scale this is years of likes; the cap just bounds the file.
const MAX_RECORDS = 5000;
const FLUSH_DELAY_MS = 1500;

export interface LikedTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  duration?: number;
}

export interface LikeRecord {
  songId: string;
  track: LikedTrack;
  // `${songId}|${startedAt}` — one airing of one song. The same song aired
  // again later is likeable again (a fresh airingKey).
  airingKey: string;
  listenerKey: string; // HMAC of the client IP — see header
  likedAt: string;     // ISO timestamp
}

let records: LikeRecord[] = [];
let secret = '';
let loaded = false;
let loadPromise: Promise<void> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function slimTrack(t: any): LikedTrack {
  const out: LikedTrack = { id: String(t.id), title: String(t.title || 'unknown') };
  if (t.artist) out.artist = String(t.artist);
  if (t.album) out.album = String(t.album);
  if (t.genre) out.genre = String(t.genre);
  if (t.year != null && Number.isFinite(Number(t.year))) out.year = Number(t.year);
  if (t.duration != null && Number.isFinite(Number(t.duration))) out.duration = Number(t.duration);
  return out;
}

function listenerKeyFor(ip: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex').slice(0, 24);
}

function airingKeyFor(songId: string, startedAt?: string | null): string {
  return `${songId}|${startedAt || 'unknown'}`;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

async function flush(): Promise<void> {
  try {
    await writeFileAtomic(STORE_FILE, JSON.stringify({ secret, likes: records }, null, 2));
  } catch {
    scheduleFlush(); // retry on the next tick
  }
}

export async function load(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (existsSync(STORE_FILE)) {
        const parsed = JSON.parse(await readFile(STORE_FILE, 'utf8')) as {
          secret?: string;
          likes?: LikeRecord[];
        };
        if (typeof parsed.secret === 'string' && parsed.secret) secret = parsed.secret;
        records = (parsed.likes || []).filter(
          (r) => r && typeof r.songId === 'string' && r.track?.id,
        );
      }
    } catch {
      /* corrupt file — start fresh, the next flush overwrites it */
    }
    if (!secret) {
      secret = randomBytes(24).toString('hex');
      scheduleFlush(); // persist the fresh secret even before the first like
    }
    loaded = true;
  })();
  return loadPromise;
}

function countForSong(songId: string): number {
  let n = 0;
  for (const r of records) if (r.songId === songId) n++;
  return n;
}

export interface RecordLikeInput {
  track: any;               // Subsonic song (or now-playing shape with .id)
  startedAt?: string | null; // the airing's start — scopes the dedup window
  ip: string;
}

export interface RecordLikeResult {
  ok: boolean;
  duplicate: boolean;
  count: number; // total likes for this song, all airings
}

// Record one like. Duplicate (same listener key, same airing) is a no-op that
// still reports the current count, so the UI can settle into the liked state.
export async function recordLike({ track, startedAt, ip }: RecordLikeInput): Promise<RecordLikeResult> {
  await load();
  const songId = String(track?.id || '');
  if (!songId) return { ok: false, duplicate: false, count: 0 };
  const airingKey = airingKeyFor(songId, startedAt);
  const listenerKey = listenerKeyFor(ip);
  if (records.some((r) => r.airingKey === airingKey && r.listenerKey === listenerKey)) {
    return { ok: true, duplicate: true, count: countForSong(songId) };
  }
  records.push({
    songId,
    track: slimTrack(track),
    airingKey,
    listenerKey,
    likedAt: new Date().toISOString(),
  });
  if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
  scheduleFlush();
  return { ok: true, duplicate: false, count: countForSong(songId) };
}

// Liked-state + count for one airing, from one listener's point of view.
export async function status({ songId, startedAt, ip }: { songId: string; startedAt?: string | null; ip: string }) {
  await load();
  const airingKey = airingKeyFor(songId, startedAt);
  const listenerKey = listenerKeyFor(ip);
  return {
    liked: records.some((r) => r.airingKey === airingKey && r.listenerKey === listenerKey),
    count: countForSong(songId),
  };
}

export interface TopLikedEntry {
  track: LikedTrack;
  count: number;
  lastLikedAt: string;
}

// Most-liked songs inside the window. Sync on purpose: pickSystem (a sync
// prompt builder) and the pool picker both read this after load() has run at
// boot; before that it just returns [].
export function topLiked({ windowDays = 30, limit = 10 }: { windowDays?: number; limit?: number } = {}): TopLikedEntry[] {
  const cutoff = windowDays > 0 ? Date.now() - windowDays * 86_400_000 : 0;
  const bySong = new Map<string, TopLikedEntry>();
  for (const r of records) {
    if (cutoff && Date.parse(r.likedAt) < cutoff) continue;
    const cur = bySong.get(r.songId);
    if (cur) {
      cur.count++;
      if (r.likedAt > cur.lastLikedAt) cur.lastLikedAt = r.likedAt;
    } else {
      bySong.set(r.songId, { track: r.track, count: 1, lastLikedAt: r.likedAt });
    }
  }
  return [...bySong.values()]
    .sort((a, b) => b.count - a.count || b.lastLikedAt.localeCompare(a.lastLikedAt))
    .slice(0, Math.max(1, limit));
}

// Recent likes for the admin card — listener key truncated to a short handle
// (enough to see "same listener", never reversible to an IP).
export function recent(limit = 30) {
  return records
    .slice(-Math.max(1, limit))
    .reverse()
    .map((r) => ({
      songId: r.songId,
      title: r.track.title,
      artist: r.track.artist || '',
      album: r.track.album || '',
      likedAt: r.likedAt,
      listener: r.listenerKey.slice(0, 8),
    }));
}

export function stats() {
  return { total: records.length, songs: new Set(records.map((r) => r.songId)).size };
}

export async function removeSong(songId: string): Promise<number> {
  await load();
  const before = records.length;
  records = records.filter((r) => r.songId !== songId);
  const removed = before - records.length;
  if (removed) scheduleFlush();
  return removed;
}

export async function clear(): Promise<number> {
  await load();
  const removed = records.length;
  records = [];
  if (removed) scheduleFlush();
  return removed;
}
