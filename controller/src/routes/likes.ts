// Listener likes (#991) — the heart button's HTTP surface.
//
// A like optionally mirrors to Navidrome as a Subsonic star
// (settings.likes.starInNavidrome), fire-and-forget. Deleting likes here does
// NOT unstar — that is the operator's catalogue data. The ONE exception is the
// operator un-heart when no likes remain: their own toggle, and the "none
// remain" guard is what stops a star earned by listener likes being discarded.

import express from 'express';
import { queue } from '../broadcast/queue.js';
import * as likes from '../broadcast/likes.js';
import * as subsonic from '../music/subsonic.js';
import * as db from '../music/library-db.js';
import * as settings from '../settings.js';
import { requireAdmin } from '../middleware/auth.js';
import { clientIp } from '../middleware/ratelimit.js';

export const router = express.Router();

// Own limiter, deliberately NOT the /request one: a like must never eat a
// listener's request quota. The store's per-airing dedup is the real ceiling.
const LIKE_COOLDOWN_MS = 2_000;
const LIKE_HOURLY_CAP = 60;
const likeHistory = new Map<string, { last: number; hits: number[] }>();

function checkLikeLimit(ip: string): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  const rec = likeHistory.get(ip) || { last: 0, hits: [] };
  rec.hits = rec.hits.filter((t) => t > oneHourAgo);
  if (rec.last && now - rec.last < LIKE_COOLDOWN_MS) {
    return { ok: false, retryAfter: Math.ceil((LIKE_COOLDOWN_MS - (now - rec.last)) / 1000) };
  }
  if (rec.hits.length >= LIKE_HOURLY_CAP) {
    return { ok: false, retryAfter: Math.ceil((rec.hits[0] + 3_600_000 - now) / 1000) };
  }
  rec.last = now;
  rec.hits.push(now);
  likeHistory.set(ip, rec);
  if (likeHistory.size > 2000) {
    for (const [k, v] of likeHistory) {
      if (!v.hits.length && now - v.last > 3_600_000) likeHistory.delete(k);
    }
  }
  return { ok: true };
}

// Prefers the queue's own current item (full Subsonic song) over the
// Liquidsoap-reported now-playing (id/title/artist only). Jingles and spoken
// segments carry no subsonic_id → null → nothing to like.
async function currentLikeable() {
  const np = await queue.getNowPlaying();
  const songId = np?.subsonic_id ? String(np.subsonic_id) : '';
  if (!songId) return null;
  const queueTrack = (queue as any).current?.track;
  const track = queueTrack?.id === songId
    ? queueTrack
    : { id: songId, title: np.title, artist: np.artist };
  return { songId, track, startedAt: np.startedAt || null, title: np.title, artist: np.artist };
}

router.post('/like', async (req, res) => {
  const cfg = settings.get()?.likes;
  if (!cfg?.enabled) return res.status(403).json({ error: 'Likes are disabled on this station' });

  const ip = clientIp(req);
  const gate = checkLikeLimit(ip);
  if (!gate.ok) {
    res.set('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'Too many likes — slow down', retryAfter: gate.retryAfter });
  }

  try {
    const on = await currentLikeable();
    if (!on) return res.status(409).json({ error: 'Nothing likeable on air right now' });
    // A stale tap must not like the wrong song.
    const asked = typeof req.body?.songId === 'string' ? req.body.songId : '';
    if (asked && asked !== on.songId) {
      return res.status(409).json({ error: 'That track just ended', songId: on.songId });
    }

    const result = await likes.recordLike({ track: on.track, startedAt: on.startedAt, ip });
    if (!result.ok) return res.status(409).json({ error: 'Nothing likeable on air right now' });

    if (!result.duplicate && cfg.starInNavidrome) {
      subsonic.star(on.songId).catch((err) =>
        console.error(`[likes] Navidrome star failed for ${on.songId}:`, err.message),
      );
    }

    res.json({
      ok: true,
      songId: on.songId,
      title: on.title,
      artist: on.artist,
      liked: true,
      alreadyLiked: result.duplicate,
      count: result.count,
    });
  } catch (err: any) {
    console.error('[likes] like failed:', err.message);
    res.status(500).json({ error: 'Could not record the like' });
  }
});

router.get('/like', async (req, res) => {
  const cfg = settings.get()?.likes;
  if (!cfg?.enabled) return res.json({ enabled: false });
  try {
    const on = await currentLikeable();
    if (!on) return res.json({ enabled: true, songId: null, liked: false, count: 0 });
    const st = await likes.status({ songId: on.songId, startedAt: on.startedAt, ip: clientIp(req) });
    res.json({ enabled: true, songId: on.songId, liked: st.liked, count: st.count });
  } catch {
    res.json({ enabled: true, songId: null, liked: false, count: 0 });
  }
});

router.get('/likes', requireAdmin, async (req, res) => {
  await likes.load();
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
  const cfg = settings.get()?.likes;
  res.json({
    totals: likes.stats(),
    top: likes.topLiked({ windowDays: cfg?.windowDays ?? 30, limit: 20 }),
    recent: likes.recent(limit),
  });
});

router.get('/likes/index', requireAdmin, async (_req, res) => {
  await likes.load();
  res.json({ songs: likes.index() });
});

// The admin library posts the row it already has; the lookups are the fallback
// for a caller that sends only an id.
async function resolveSnapshot(id: string, body: any) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.title || b.artist) {
    return { id, title: b.title, artist: b.artist, album: b.album, genre: b.genre, year: b.year, duration: b.duration };
  }
  try {
    const row: any = db.getTrack(id);
    if (row) {
      return { id, title: row.title, artist: row.artist, album: row.album, genre: row.genre, year: row.year, duration: row.durationSec };
    }
  } catch { /* index unavailable — fall through to Navidrome */ }
  try {
    const song: any = await subsonic.getSong(id);
    if (song) return { ...song, id };
  } catch { /* Navidrome down — a bare snapshot still records the like */ }
  return { id, title: 'unknown' };
}

router.post('/likes/song/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  if (!id) return res.status(400).json({ error: 'A song id is required' });
  try {
    const track = await resolveSnapshot(id, req.body);
    const result = await likes.operatorLike(track);
    if (!result.ok) return res.status(400).json({ error: 'A song id is required' });
    if (result.added && settings.get()?.likes?.starInNavidrome) {
      subsonic.star(id).catch((err) =>
        console.error(`[likes] Navidrome star failed for ${id}:`, err.message),
      );
    }
    res.json({ ok: true, songId: id, operator: true, added: result.added, count: result.count });
  } catch (err: any) {
    console.error('[likes] operator like failed:', err.message);
    res.status(500).json({ error: 'Could not record the like' });
  }
});

router.delete('/likes/song/:id/operator', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  try {
    const result = await likes.operatorUnlike(id);
    // Only when the operator's heart was the LAST like standing — see header.
    if (result.removed && result.count === 0 && settings.get()?.likes?.starInNavidrome) {
      subsonic.unstar(id).catch((err) =>
        console.error(`[likes] Navidrome unstar failed for ${id}:`, err.message),
      );
    }
    res.json({ ok: true, songId: id, operator: false, removed: result.removed, count: result.count });
  } catch (err: any) {
    console.error('[likes] operator unlike failed:', err.message);
    res.status(500).json({ error: 'Could not remove the like' });
  }
});

router.delete('/likes/song/:id', requireAdmin, async (req, res) => {
  const removed = await likes.removeSong(String(req.params.id));
  res.json({ ok: true, removed });
});

router.delete('/likes', requireAdmin, async (_req, res) => {
  const removed = await likes.clear();
  res.json({ ok: true, removed });
});
