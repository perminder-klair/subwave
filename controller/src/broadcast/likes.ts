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
//
// Operator likes (#1253) ride the same records under a reserved listener key.
// They are curation rather than a taste snapshot, which is why they are exempt
// from both the topLiked() window and the MAX_RECORDS trim — see OPERATOR_KEY.

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

// The operator's own heart, from the admin library. A reserved listener key,
// not an HMAC — it cannot collide, because a real key is always 24 hex chars.
// Pairing it with a synthetic airing key makes an operator like idempotent per
// song (one forever) through the exact same dedup a listener like uses.
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
  // `${songId}|${startedAt}` — one airing of one song. The same song aired
  // again later is likeable again (a fresh airingKey).
  airingKey: string;
  listenerKey: string; // HMAC of the client IP — see header
  likedAt: string;     // ISO timestamp
  // Absent on a listener like (every record written before #1253), so nothing
  // needs backfilling — missing means listener, which is already correct.
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

// Persist now, surfacing a write failure. The debounced flush() below
// deliberately swallows one and retries on the next tick, which is right for a
// like arriving and wrong for a caller that is about to destroy the only record
// of what still needs writing — music/id-rotation.ts consumes the rotation
// manifest the moment its remap returns.
async function flushStrict(): Promise<void> {
  await writeFileAtomic(STORE_FILE, JSON.stringify({ secret, likes: records }, null, 2));
}

async function flush(): Promise<void> {
  try {
    await flushStrict();
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

// Rewrite record ids after a Navidrome ID rotation (music/id-rotation.ts),
// via the adoption-confirmed old→new map only. The airingKey keeps its
// `${songId}|${startedAt}` shape (split at the FIRST `|` — startedAt is an ISO
// timestamp and never contains one before the offset marker — which also keeps
// the operator heart's synthetic `${songId}|operator` key intact). Flushes
// through flushStrict: the caller deletes the rotation manifest right after, so
// the rewrite must be on disk first — not sitting in the debounce window, and
// not reported as written when the write actually failed.
export async function remapTrackIds(trackMap: ReadonlyMap<string, string>): Promise<number> {
  await load();
  // Counts RECORDS moved, not fields written — songId and the snapshot id are
  // normally the same value, so counting both would report twice the likes.
  let changed = 0;
  for (const r of records) {
    let touched = false;
    const bySong = trackMap.get(r.songId);
    if (bySong) {
      const rest = r.airingKey.startsWith(`${r.songId}|`)
        ? r.airingKey.slice(r.songId.length + 1)
        : null;
      r.songId = bySong;
      if (rest !== null) r.airingKey = `${bySong}|${rest}`;
      touched = true;
    }
    const byTrack = trackMap.get(r.track.id);
    if (byTrack && byTrack !== r.track.id) {
      // Marks the store dirty in its own right: the snapshot id normally equals
      // songId, but if it ever didn't, mutating it without setting the flag
      // would leave the rewrite in memory only — and the caller deletes the
      // manifest the moment this returns.
      r.track.id = byTrack;
      touched = true;
    }
    if (touched) changed++;
  }
  if (changed) await flushStrict();
  return changed;
}

function countForSong(songId: string): number {
  let n = 0;
  for (const r of records) if (r.songId === songId) n++;
  return n;
}

// Bound the store, evicting oldest LISTENER records first. An operator like is
// curation the operator set by hand; letting listener volume evict it would
// silently undo that. Exported for the unit test, which can't reach 5000 rows.
export function trimTo(max: number): void {
  if (records.length <= max) return;
  const operators = records.filter(isOperator);
  // More curation than the cap can hold means the store is far outside its
  // design envelope — fall back to plain oldest-first so the cap still holds.
  if (operators.length >= max) {
    records = records.slice(-max);
    return;
  }
  const keep = new Set<LikeRecord>(operators);
  const room = max - operators.length;
  const listeners = records.filter((r) => !isOperator(r));
  for (const r of listeners.slice(-room)) keep.add(r);
  // Filter rather than concat, so surviving records stay in insertion order
  // (recent() reads off the tail and would otherwise report a bogus ordering).
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
  trimTo(MAX_RECORDS);
  scheduleFlush();
  return { ok: true, duplicate: false, count: countForSong(songId) };
}

// --- operator likes (#1253) -------------------------------------------------

// The operator hearting a track from the admin library. Idempotent per song:
// a second call is a no-op that still reports the count, so a double-tap can
// never write two records.
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

// Un-heart. Removes ONLY the operator's own record — every listener like for
// the song survives, which is what makes this a toggle rather than a purge.
// `remaining` lets the route decide whether unstarring Navidrome is safe.
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

// Compact {songId: {count, operator}} map — what decorates the heart on every
// admin library row, whatever source the row came from (library.db, Navidrome
// search, CLAP KNN). Bounded by distinct liked songs, so <= MAX_RECORDS.
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

// Every liked song, one entry each, newest snapshot wins. Unsorted — the route
// owns ordering. All time, unlike topLiked(): this is the operator's library
// view, not the picker's recency-weighted taste signal.
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

// Most-liked songs inside the window. Sync on purpose: favouritesClause (a
// sync prompt builder) and the pool picker both read this after load() has run
// at boot; before that it just returns [].
export function topLiked({ windowDays = 30, limit = 10 }: { windowDays?: number; limit?: number } = {}): TopLikedEntry[] {
  const cutoff = windowDays > 0 ? Date.now() - windowDays * 86_400_000 : 0;
  const bySong = new Map<string, TopLikedEntry>();
  for (const r of records) {
    // Operator likes never age out. A listener like falling past the window is
    // the point — it's a snapshot of recent taste. An operator like falling out
    // would read as the DJ quietly forgetting a favourite the operator set.
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

// The listener-favourites clause for the pick EVENT turn (#991). Lives here —
// next to the store it reads — so dj-agent renders it and the placement test
// can pin it without importing the agent. Deliberately NOT part of pickSystem:
// the list changes as likes land, and re-rendering it inside the system prompt
// breaks the byte-stable prefix automatic prompt caching keys on. Returns ''
// when the operator hasn't opted in or nothing is liked, so the event turn is
// byte-identical to a likes-free station.
export function favouritesClause(cfg: { enabled?: boolean; influenceDj?: boolean; windowDays?: number; maxTracks?: number } | null | undefined): string {
  if (!cfg?.enabled || !cfg?.influenceDj) return '';
  const favs = topLiked({ windowDays: cfg.windowDays, limit: cfg.maxTracks });
  if (!favs.length) return '';
  return ` Listener favourites — the most-liked tracks on this station recently: ${favs
    .map((f) => `"${f.track.title}" by ${f.track.artist || 'unknown'} (${f.count})`)
    .join('; ')}. Treat these as a strong preference signal when they fit the moment — but keep variety, never loop the same favourites back-to-back.`;
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
