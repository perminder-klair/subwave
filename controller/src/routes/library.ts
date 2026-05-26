// Admin-gated music-library management surface — backs /admin/library.
// Browse + filter the tagged index (moods.json), page through untagged
// tracks, retag a single track inline, and report coverage stats.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as library from '../music/library.js';
import * as coverage from '../music/library-coverage.js';
import * as subsonic from '../music/subsonic.js';
import * as settings from '../settings.js';
import { tagOne, TAGGER_BATCH_SYSTEM } from '../music/tagger-core.js';
import { promptVocabHash } from '../music/embeddings.js';
import { activeModelLabel } from '../llm/provider.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// GET /library/browse — filter the tagged index.
// Query: moods=a,b energy=low genre=Rock yearFrom=1990 yearTo=2000
//        q=foo sort=artist|title|year|taggedAt limit=50 offset=0
// ---------------------------------------------------------------------------
router.get('/library/browse', requireAdmin, async (req, res) => {
  try {
    await library.load();
    const q = req.query || {};
    const moods = parseList(q.moods);
    const sort = (typeof q.sort === 'string' ? q.sort : 'artist') as
      | 'artist' | 'title' | 'year' | 'taggedAt';
    const limit = parseIntSafe(q.limit, 50);
    const offset = parseIntSafe(q.offset, 0);
    const yearFrom = parseIntSafe(q.yearFrom, null);
    const yearTo = parseIntSafe(q.yearTo, null);

    const result = library.filter({
      moods,
      energy: typeof q.energy === 'string' && q.energy ? q.energy : null,
      genre: typeof q.genre === 'string' && q.genre ? q.genre : null,
      yearFrom,
      yearTo,
      q: typeof q.q === 'string' ? q.q : null,
      sort,
      limit,
      offset,
    });
    const stats = library.stats();
    res.json({
      ...result,
      moodVocab: settings.SHOW_MOODS,
      stats: {
        total: stats.total,
        byMood: stats.byMood,
        byEnergy: stats.byEnergy,
        byGenre: stats.byGenre,
        updatedAt: stats.updatedAt,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /library/genres — distinct genres for the filter dropdown.
// Merges Navidrome's getGenres() with whatever's already in the tagged index.
// Cached at the Subsonic layer; cheap enough to hit per page-load.
// ---------------------------------------------------------------------------
router.get('/library/genres', requireAdmin, async (req, res) => {
  try {
    await library.load();
    const tagged = library.stats().byGenre || {};
    let navidromeGenres: { value: string; songCount?: number }[] = [];
    try { navidromeGenres = await subsonic.getGenres(); } catch {}
    const merged: Record<string, number> = { ...tagged };
    for (const g of navidromeGenres || []) {
      if (!g?.value) continue;
      if (merged[g.value] == null) merged[g.value] = g.songCount || 0;
    }
    const list = Object.entries(merged)
      .map(([value, songCount]) => ({ value, songCount }))
      .sort((a, b) => b.songCount - a.songCount);
    res.json({ genres: list });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /library/untagged?limit=&cursor=
// Cursor is an opaque base64 of `albumOffset:songIndexInAlbum` so the next
// request resumes where the last one stopped. Returns up to `limit` untagged
// rows + a nextCursor (or null if the walk reached the end).
// ---------------------------------------------------------------------------
router.get('/library/untagged', requireAdmin, async (req, res) => {
  await library.load();
  const limit = Math.min(Math.max(parseIntSafe(req.query?.limit, 50) ?? 50, 1), 100);
  const cursor = decodeCursor(typeof req.query?.cursor === 'string' ? req.query.cursor : '');
  const startAlbumOffset = cursor.albumOffset;
  const startSongIndex = cursor.songIndex;

  const rows: any[] = [];
  let nextCursor: string | null = null;
  let visited = 0;
  const SCAN_BUDGET = 5000; // avoid pathological full-library walks per request
  const BATCH = 200;
  let albumOffset = startAlbumOffset;
  let songIndex = startSongIndex;

  try {
    outer: while (visited < SCAN_BUDGET) {
      const albums = await subsonic.getAlbumList(albumOffset, BATCH);
      if (albums.length === 0) break;
      for (let i = 0; i < albums.length; i++) {
        const album = albums[i];
        let songs: any[] = [];
        try { songs = await subsonic.getAlbum(album.id); } catch { songs = []; }
        for (let j = (i === 0 ? songIndex : 0); j < songs.length; j++) {
          const s = songs[j];
          visited++;
          if (library.has(s.id)) continue;
          rows.push({
            id: s.id,
            title: s.title,
            artist: s.artist,
            album: s.album,
            year: s.year ?? null,
            genre: s.genre ?? null,
            duration: s.duration ?? null,
          });
          if (rows.length >= limit) {
            // Resume from the next song in this album.
            nextCursor = encodeCursor({
              albumOffset: albumOffset + i,
              songIndex: j + 1,
            });
            break outer;
          }
        }
      }
      if (albums.length < BATCH) break;
      albumOffset += albums.length;
      songIndex = 0;
    }
    res.json({ rows, nextCursor });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /library/coverage — { tagged, total, percent, scannedAt, scanning }
// `total` / `percent` are null until the first background scan completes.
// ---------------------------------------------------------------------------
router.get('/library/coverage', requireAdmin, async (req, res) => {
  try {
    if (req.query?.refresh === '1') coverage.refresh();
    res.json(await coverage.get());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /library/retag — inline single-track tag refresh.
// Body: { id, title?, artist?, album?, year?, genre? }
// Metadata is taken from the body if present, otherwise we re-fetch via
// Subsonic search. Writes the new tags into the in-memory store + moods.json.
// ---------------------------------------------------------------------------
router.post('/library/retag', requireAdmin, async (req, res) => {
  const id = req.body?.id;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
  try {
    await library.load();
    let song: any = req.body || {};
    if (!song.title || !song.artist) {
      // Reach back to Subsonic to fill metadata when the caller only sent an id.
      const found = await subsonic.search(`${song.title || ''} ${song.artist || ''}`.trim() || id, { songCount: 25 });
      const hit = (found || []).find((s: any) => s.id === id);
      if (hit) song = { ...hit, ...song };
    }
    if (!song.title) return res.status(404).json({ error: 'track metadata not found' });

    const { moods, energy } = await tagOne(song);
    library.set(id, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year,
      genre: song.genre,
      moods,
      energy,
      source: 'llm',
      promptHash: promptVocabHash(TAGGER_BATCH_SYSTEM),
      model: activeModelLabel(),
    });
    await library.save();
    const tagged = library.get(id);
    res.json({ id, moods, energy, taggedAt: tagged?.taggedAt });
  } catch (err: any) {
    queue.log('error', `/library/retag failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function parseList(v: any): string[] {
  if (Array.isArray(v)) return v.flatMap((x: any) => parseList(x));
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function parseIntSafe<T extends number | null>(v: any, dflt: T): number | T {
  if (v == null || v === '') return dflt;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function encodeCursor(c: { albumOffset: number; songIndex: number }) {
  return Buffer.from(`${c.albumOffset}:${c.songIndex}`, 'utf8').toString('base64url');
}
function decodeCursor(s: string): { albumOffset: number; songIndex: number } {
  if (!s) return { albumOffset: 0, songIndex: 0 };
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf8');
    const [a, b] = decoded.split(':');
    const albumOffset = parseInt(a, 10);
    const songIndex = parseInt(b, 10);
    if (!Number.isFinite(albumOffset) || !Number.isFinite(songIndex)) return { albumOffset: 0, songIndex: 0 };
    return { albumOffset, songIndex };
  } catch {
    return { albumOffset: 0, songIndex: 0 };
  }
}
