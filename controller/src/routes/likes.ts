// Listener likes (#991) — the heart button's HTTP surface.
//
//   POST /like        public   like the currently playing track
//   GET  /like        public   liked-state + count for the current airing
//   GET  /likes       admin    totals + top liked + recent activity
//   DELETE /likes/song/:id  admin  drop all likes for one song
//   DELETE /likes     admin    clear the store
//
// A like optionally mirrors to Navidrome as a Subsonic star
// (settings.likes.starInNavidrome) — fire-and-forget, so a slow or down
// Navidrome never blocks the tap. Deleting likes here does NOT unstar in
// Navidrome: stars there are the operator's catalogue data; prune them in a
// Subsonic client if wanted.

import express from 'express';
import { queue } from '../broadcast/queue.js';
import * as likes from '../broadcast/likes.js';
// The star write-back is a Subsonic/Navidrome capability by design
// (settings.likes.starInNavidrome), not part of the MusicSource facade —
// import the source module directly, like the playlists routes do.
import * as subsonic from '../music/sources/subsonic.js';
import { activeSourceId } from '../music/source.js';
import * as settings from '../settings.js';
import { requireAdmin } from '../middleware/auth.js';
import { clientIp } from '../middleware/ratelimit.js';

export const router = express.Router();

// Own limiter, deliberately NOT the /request one: a like must never eat a
// listener's request quota, and likes are far cheaper (no LLM/TTS). The
// per-airing dedup in the store is the real ceiling — this just blunts floods.
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

// The likeable thing on air right now. Prefers the queue's own current item
// (full Subsonic song — album/genre/year ride into the stored snapshot) and
// falls back to the Liquidsoap-reported now-playing (id/title/artist only).
// Jingles and spoken segments carry no subsonic_id → null → nothing to like.
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
    // A stale tap (track changed between render and click) must not like the
    // wrong song — the client sends what it thinks is playing.
    const asked = typeof req.body?.songId === 'string' ? req.body.songId : '';
    if (asked && asked !== on.songId) {
      return res.status(409).json({ error: 'That track just ended', songId: on.songId });
    }

    const result = await likes.recordLike({ track: on.track, startedAt: on.startedAt, ip });
    if (!result.ok) return res.status(409).json({ error: 'Nothing likeable on air right now' });

    // Mirror into Navidrome on every accepted (non-duplicate) like — star is
    // idempotent, and re-starring heals a star the operator removed by hand
    // only when listeners actually like the song again. Only meaningful when
    // the active music source IS Navidrome/Subsonic (the default `true` would
    // otherwise error on every like on a Plex/local-folder station).
    if (!result.duplicate && cfg.starInNavidrome && activeSourceId() === 'subsonic') {
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

// --- admin -----------------------------------------------------------------

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

router.delete('/likes/song/:id', requireAdmin, async (req, res) => {
  const removed = await likes.removeSong(String(req.params.id));
  res.json({ ok: true, removed });
});

router.delete('/likes', requireAdmin, async (_req, res) => {
  const removed = await likes.clear();
  res.json({ ok: true, removed });
});
