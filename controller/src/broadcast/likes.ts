// Listener likes (#991) — records in state/likes.json, each with a slim track
// snapshot so the picker can feed favourites back without a Subsonic round-trip.
// Dedup is one like per apparent listener per AIRING, keyed by HMAC(secret, ip):
// the raw IP is never stored and the secret is persisted so dedup survives
// restarts. Listeners behind one NAT share a key — dedup, not identity.
//
// Navidrome star write-back is the route's job, not this module's.
// Operator likes (#1253) ride the same records under a reserved listener key and
// are exempt from both the topLiked() window and the MAX_RECORDS trim.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

const STORE_FILE = join(config.stateDir, 'likes.json');
// Hard cap on stored records, oldest trimmed first.
const MAX_RECORDS = 5000;
const FLUSH_DELAY_MS = 1500;

// Reserved listener key, not an HMAC: it cannot collide, since a real key is
// always 24 hex chars. Paired with a synthetic airing key so an operator like is
// idempotent per song through the same dedup a listener like uses.
export const OPERATOR_KEY = 'operator';
const operatorAiringKey = (songId: string) => `${songId}|operator`;
const isOperator = (r: LikeRecord) => r.via === 'operator';

interface LikedTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  duration?: number;
}

interface LikeRecord {
  songId: string;
  track: LikedTrack;
  // `${songId}|${startedAt}` — one airing. A later airing is likeable again.
  airingKey: string;
  listenerKey: string; // HMAC of the client IP
  likedAt: string;     // ISO timestamp
  // Absent on a listener like, so pre-#1253 records need no backfill.
  via?: 'operator';
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

// Evicts oldest LISTENER records first: listener volume must not evict curation.
// Exported for the unit test, which can't reach 5000 rows.
export function trimTo(max: number): void {
  if (records.length <= max) return;
  const operators = records.filter(isOperator);
  // More curation than the cap can hold: fall back to oldest-first.
  if (operators.length >= max) {
    records = records.slice(-max);
    return;
  }
  const keep = new Set<LikeRecord>(operators);
  const room = max - operators.length;
  const listeners = records.filter((r) => !isOperator(r));
  for (const r of listeners.slice(-room)) keep.add(r);
  // Filter rather than concat, so survivors keep insertion order (recent() reads
  // off the tail).
  records = records.filter((r) => keep.has(r));
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

// A duplicate (same listener key, same airing) is a no-op that still reports the
// count, so the UI settles into the liked state.
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
  trimTo(MAX_RECORDS);
  scheduleFlush();
  return { ok: true, duplicate: false, count: countForSong(songId) };
}

// Idempotent per song: a double-tap can never write two records.
export async function operatorLike(track: any): Promise<{ ok: boolean; added: boolean; count: number }> {
  await load();
  const songId = String(track?.id || '');
  if (!songId) return { ok: false, added: false, count: 0 };
  if (records.some((r) => r.songId === songId && isOperator(r))) {
    return { ok: true, added: false, count: countForSong(songId) };
  }
  records.push({
    songId,
    track: slimTrack(track),
    airingKey: operatorAiringKey(songId),
    listenerKey: OPERATOR_KEY,
    likedAt: new Date().toISOString(),
    via: 'operator',
  });
  trimTo(MAX_RECORDS);
  scheduleFlush();
  return { ok: true, added: true, count: countForSong(songId) };
}

// Removes ONLY the operator's own record; listener likes survive. The count lets
// the route decide whether unstarring Navidrome is safe.
export async function operatorUnlike(songId: string): Promise<{ removed: boolean; count: number }> {
  await load();
  const before = records.length;
  records = records.filter((r) => !(r.songId === songId && isOperator(r)));
  const removed = before !== records.length;
  if (removed) scheduleFlush();
  return { removed, count: countForSong(songId) };
}

export function operatorLiked(songId: string): boolean {
  return records.some((r) => r.songId === songId && isOperator(r));
}

// Decorates the heart on every admin library row, whatever its source.
export function index(): Record<string, { count: number; operator: boolean }> {
  const out: Record<string, { count: number; operator: boolean }> = Object.create(null);
  for (const r of records) {
    const cur = out[r.songId];
    if (cur) {
      cur.count++;
      if (isOperator(r)) cur.operator = true;
    } else {
      out[r.songId] = { count: 1, operator: isOperator(r) };
    }
  }
  return out;
}

export interface LikedSong {
  songId: string;
  track: LikedTrack;
  count: number;
  operator: boolean;
  lastLikedAt: string;
}

// One entry per liked song, newest snapshot wins. Unsorted (the route orders) and
// all-time, unlike topLiked().
export function likedSongs(): LikedSong[] {
  const bySong = new Map<string, LikedSong>();
  for (const r of records) {
    const cur = bySong.get(r.songId);
    if (cur) {
      cur.count++;
      if (isOperator(r)) cur.operator = true;
      if (r.likedAt > cur.lastLikedAt) {
        cur.lastLikedAt = r.likedAt;
        cur.track = r.track;
      }
    } else {
      bySong.set(r.songId, {
        songId: r.songId,
        track: r.track,
        count: 1,
        operator: isOperator(r),
        lastLikedAt: r.likedAt,
      });
    }
  }
  return [...bySong.values()];
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

// Sync on purpose: favouritesClause and the pool picker read it after load() has
// run at boot; before that it returns [].
export function topLiked({ windowDays = 30, limit = 10 }: { windowDays?: number; limit?: number } = {}): TopLikedEntry[] {
  const cutoff = windowDays > 0 ? Date.now() - windowDays * 86_400_000 : 0;
  const bySong = new Map<string, TopLikedEntry>();
  for (const r of records) {
    // Operator likes never age out: a listener like ageing is a taste snapshot
    // expiring, an operator like ageing is curation being forgotten.
    if (cutoff && !isOperator(r) && Date.parse(r.likedAt) < cutoff) continue;
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

// The listener-favourites clause for the pick EVENT turn (#991). Deliberately NOT
// part of pickSystem: the list changes as likes land, and re-rendering it there
// would break the byte-stable prefix prompt caching keys on. Returns '' when not
// opted in or nothing is liked, so the event turn stays byte-identical.
export function favouritesClause(cfg: { enabled?: boolean; influenceDj?: boolean; windowDays?: number; maxTracks?: number } | null | undefined): string {
  if (!cfg?.enabled || !cfg?.influenceDj) return '';
  const favs = topLiked({ windowDays: cfg.windowDays, limit: cfg.maxTracks });
  if (!favs.length) return '';
  return ` Listener favourites — the most-liked tracks on this station recently: ${favs
    .map((f) => `"${f.track.title}" by ${f.track.artist || 'unknown'} (${f.count})`)
    .join('; ')}. Treat these as a strong preference signal when they fit the moment — but keep variety, never loop the same favourites back-to-back.`;
}

// Listener key truncated to a short handle: enough to spot "same listener",
// never reversible to an IP.
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
