import express from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import * as library from '../../music/library.js';
import * as blocklist from '../../music/blocklist.js';
import * as likes from '../../broadcast/likes.js';
import * as db from '../../music/library-db.js';
import * as analyzer from '../../music/analyzer.js';
import * as subsonic from '../../music/subsonic.js';
import * as settings from '../../settings.js';
import { isInstrumental } from '../../music/lyric-vocal.js';
import { soundKnnWidth } from '../../util/similar-tracks.js';
import { buildGenreSuggest } from '../../music/genre-suggest.js';
import { parseList, parseIntSafe } from './params.js';

export const router = express.Router();

router.get('/library/browse', requireAdmin, async (req, res) => {
  try {
    await library.load();
    const q = req.query || {};
    const moods = parseList(q.moods);
    const sort = (typeof q.sort === 'string' ? q.sort : 'artist') as
      | 'artist' | 'title' | 'year' | 'taggedAt' | 'bpm' | 'loudness' | 'pace';
    const vocal = q.vocal === 'instrumental' || q.vocal === 'vocal' ? q.vocal : null;
    const limit = parseIntSafe(q.limit, 50);
    const offset = parseIntSafe(q.offset, 0);
    const yearFrom = parseIntSafe(q.yearFrom, null);
    const yearTo = parseIntSafe(q.yearTo, null);

    const result = library.filter({
      moods,
      energy: typeof q.energy === 'string' && q.energy ? q.energy : null,
      genre: typeof q.genre === 'string' && q.genre ? q.genre : null,
      vocal,
      yearFrom,
      yearTo,
      q: typeof q.q === 'string' ? q.q : null,
      sort,
      limit,
      offset,
    });
    // Drop station-archive rows an old tagger may have written into the index (#273).
    const cleanRows = result.rows.filter((row) => !subsonic.isStationArchive(row));
    const removed = result.rows.length - cleanRows.length;
    // Blocked rows stay listed, annotated so the UI can mark and unblock them.
    result.rows = blocklist.annotate(cleanRows);
    result.total = Math.max(0, result.total - removed);
    const stats = library.stats();
    res.json({
      ...result,
      moodVocab: settings.moodVocab(),
      stats: {
        total: stats.total,
        byMood: stats.byMood,
        byEnergy: stats.byEnergy,
        byGenre: stats.byGenre,
        updatedAt: stats.updatedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/library/history', requireAdmin, async (req, res) => {
  try {
    await library.load();
    const limit = Math.min(Math.max(parseIntSafe(req.query?.limit, 50), 1), 200);
    const offset = Math.max(parseIntSafe(req.query?.offset, 0), 0);
    const { total, rows } = db.listPlays({ limit, offset });
    res.json({ total, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liked mode of the admin Library Tracks tab. Sourced from the likes store,
// not library.db: a liked track may never have been tagged.
router.get('/library/liked', requireAdmin, async (req, res) => {
  try {
    await library.load();
    await likes.load();
    const limit = Math.min(Math.max(parseIntSafe(req.query?.limit, 50), 1), 200);
    const offset = Math.max(parseIntSafe(req.query?.offset, 0), 0);
    const sort = req.query?.sort === 'count' || req.query?.sort === 'artist'
      ? req.query.sort
      : 'recent';
    const q = (typeof req.query?.q === 'string' ? req.query.q : '').trim().toLowerCase();

    const rows = likes.likedSongs().map((entry) => {
      let rec: any = null;
      try { rec = db.getTrack(entry.songId); } catch { /* index unavailable */ }
      const snap = entry.track;
      return {
        id: entry.songId,
        title: rec?.title ?? snap.title ?? null,
        artist: rec?.artist ?? snap.artist ?? null,
        album: rec?.album ?? snap.album ?? null,
        year: rec?.year ?? snap.year ?? null,
        originalYear: rec?.originalYear ?? null,
        originalYearSource: rec?.originalYearSource ?? null,
        isCompilation: rec?.isCompilation ?? null,
        eraUntrusted: rec?.eraUntrusted ?? null,
        genre: rec?.genre ?? snap.genre ?? null,
        duration: snap.duration ?? rec?.durationSec ?? null,
        moods: rec?.moods ?? [],
        energy: rec?.energy ?? null,
        source: rec?.source ?? null,
        taggedAt: rec?.taggedAt ?? null,
        bpm: rec?.bpm ?? null,
        musicalKey: rec?.musicalKey ?? null,
        loudnessLufs: rec?.loudnessLufs ?? null,
        instrumental: isInstrumental(rec?.vocalRanges),
        likeCount: entry.count,
        likedByOperator: entry.operator,
        lastLikedAt: entry.lastLikedAt,
      };
    });

    // As in Browse: a blocked track still lists, annotated so the row can offer the lift.
    const annotated = blocklist.annotate(
      rows.filter((row) => !subsonic.isStationArchive(row)),
    );

    const matched = q
      ? annotated.filter((r) =>
        `${r.title ?? ''} ${r.artist ?? ''} ${r.album ?? ''}`.toLowerCase().includes(q))
      : annotated;

    const byName = (r: typeof annotated[number]) =>
      `${(r.artist ?? '').toLowerCase()} ${(r.album ?? '').toLowerCase()} ${(r.title ?? '').toLowerCase()}`;
    matched.sort((a, b) => {
      if (sort === 'artist') return byName(a).localeCompare(byName(b));
      // Equal counts tie-break on recency so the order is stable.
      if (sort === 'count' && b.likeCount !== a.likeCount) return b.likeCount - a.likeCount;
      return b.lastLikedAt.localeCompare(a.lastLikedAt);
    });

    res.json({ total: matched.length, rows: matched.slice(offset, offset + limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Natural-language "sounds like" search: CLAP text embed, KNN over track audio
// vectors. 503 when the capability is missing.
router.get('/library/search-sound', requireAdmin, async (req, res) => {
  const q = (typeof req.query?.q === 'string' ? req.query.q : '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  const limit = Math.min(Math.max(parseIntSafe(req.query?.limit, 30), 1), 60);
  try {
    await library.load();
    // Short deadline: a bulk pass may hold the analyzer's single worker.
    const vecs = await analyzer.embedTexts([q], { timeoutMs: 20_000 });
    if (!vecs || !vecs[0]) {
      return res.status(503).json({
        error: 'sound search unavailable — needs the heavy analyzer (CLAP text tower) and audio-analysed tracks',
      });
    }
    // Wide KNN, capped after the archive filter. Same width rule as /similar-tracks.
    const hits = library.tracksByAudioVector(vecs[0], soundKnnWidth(limit));
    const results = hits
      .filter((t) => !subsonic.isStationArchive(t))
      .slice(0, limit)
      .map((t) => ({
        id: t.id,
        title: t.title ?? null,
        artist: t.artist ?? null,
        album: t.album ?? null,
        year: t.year ?? null,
        originalYear: t.originalYear ?? null,
        originalYearSource: t.originalYearSource ?? null,
        isCompilation: t.isCompilation ?? null,
        eraUntrusted: t.eraUntrusted ?? null,
        genre: t.genre ?? null,
        duration: t.durationSec ?? null,
        moods: t.moods ?? [],
        energy: t.energy ?? null,
        source: t.source ?? null,
        bpm: t.bpm ?? null,
        musicalKey: t.musicalKey ?? null,
        loudnessLufs: t.loudnessLufs ?? null,
        instrumental: isInstrumental(t.vocalRanges),
        similarity: typeof t._similarity === 'number' ? t._similarity : null,
      }));
    res.json({ results: blocklist.annotate(results) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Distinct genres for the filter dropdown: Navidrome's getGenres() merged with
// the tagged index, cached at the Subsonic layer.
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Genres by track count plus, per genre, its nearest genres by embedding cosine.
// Cached until the library changes.
router.get('/library/genres/related', requireAdmin, async (_req, res) => {
  try {
    await library.load();
    res.json(buildGenreSuggest());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
