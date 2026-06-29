// Admin-gated music-library management surface — backs /admin/library.
// Browse + filter the tagged index (SQLite library-db), page through
// untagged tracks, retag a single track inline (through the same bulk
// pipeline — enrich + embed + LLM tag), and report coverage stats.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as library from '../music/library.js';
import * as db from '../music/library-db.js';
import * as coverage from '../music/library-coverage.js';
import * as subsonic from '../music/subsonic.js';
import * as lastfm from '../music/lastfm.js';
import * as settings from '../settings.js';
import * as embeddings from '../music/embeddings.js';
import { buildGenreSuggest } from '../music/genre-suggest.js';
import { tagBatch, TAGGER_BATCH_SYSTEM } from '../music/tagger-core.js';
import { promptVocabHash } from '../music/embeddings.js';
import { activeModelLabel } from '../llm/provider.js';
import { queue } from '../broadcast/queue.js';
import { tagger, startAnalyzer, startReconcile } from '../broadcast/tagger.js';

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
    // Drop any station-archive rows the tagger may have written into the index
    // before the subsonic-layer guard existed (issue #273), so the admin library
    // is clean without requiring a re-tag.
    const cleanRows = result.rows.filter((row) => !subsonic.isStationArchive(row));
    const removed = result.rows.length - cleanRows.length;
    result.rows = cleanRows;
    result.total = Math.max(0, result.total - removed);
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
// GET /library/genres/related — genre suggestions for the show editor. Returns
// the full genre list (by track count) plus, per genre, its nearest genres by
// embedding similarity (cosine over each genre's mean text-embedding). Powers
// the related-genre chips: popular quick-picks when empty, semantic neighbours
// once a genre is chosen. Cached until the library changes.
// ---------------------------------------------------------------------------
router.get('/library/genres/related', requireAdmin, async (_req, res) => {
  try {
    await library.load();
    res.json(buildGenreSuggest());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /library/observatory — the bulk dataset behind the Library Observatory
// (web/app/observatory). Returns every *tagged* track in one shot so the
// constellation can place all nodes at once. Projected to just what the map /
// tooltip / filters / stat panels need — lastfm tags, lyric excerpts and
// embeddings are deliberately omitted here (they'd bloat a multi-thousand-row
// payload) and loaded lazily per selected track by the /track/:id endpoint.
// Capped at `max` (default OBSERVATORY_DEFAULT_MAX, raisable per-request via
// ?max= up to OBSERVATORY_HARD_MAX); above the cap a stratified per-genre sample
// is returned with `sampled`/`truncated` flags. Station-archive rows are dropped
// (issue #273).
// ---------------------------------------------------------------------------
// Default node cap (env-overridable) and the hard ceiling the client may raise
// it to from the UI (?max=). 10000 covers most personal libraries in full while
// keeping the payload sane; above it the observatory's MAP SIZE control dials up
// to OBSERVATORY_HARD_MAX. Above the cap we return a stratified sample. The web
// client mirrors this default (ObservatoryApp DEFAULT_MAX) so a fresh browser
// and a direct API caller agree. (Libraries above ~3k render on the canvas
// renderer; only small ones keep the animated SVG path.)
const OBSERVATORY_DEFAULT_MAX = Math.max(500, Number(process.env.OBSERVATORY_MAX) || 10000);
const OBSERVATORY_HARD_MAX = Math.max(OBSERVATORY_DEFAULT_MAX, Number(process.env.OBSERVATORY_HARD_MAX) || 50000);
router.get('/library/observatory', requireAdmin, async (req, res) => {
  try {
    await library.load();
    const stats = library.stats();
    const total = stats.total;
    const requested = Number(req.query.max);
    const max = Math.min(
      OBSERVATORY_HARD_MAX,
      Math.max(500, Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : OBSERVATORY_DEFAULT_MAX),
    );
    const sampled = total > max;
    const all = sampled ? db.allTaggedSampled(max, total) : db.allTagged();
    const truncated = sampled;
    const tracks = all
      .filter((t) => !subsonic.isStationArchive(t))
      .slice(0, max)
      .map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        year: t.year,
        genre: t.genre,
        durationSec: t.durationSec,
        moods: t.moods,
        energy: t.energy,
        source: t.source,
        confidence: t.confidence,
        bpm: t.bpm,
        musicalKey: t.musicalKey,
        analysisConfidence: t.analysisConfidence,
        // Cheap acoustic scalars for the Observatory's colour-by + aggregate
        // panels. The full curves/ranges stay on the per-track dossier endpoint.
        loudnessLufs: t.loudnessLufs,
        paceMean: library.paceMeanOf(t.pace),
        // Tri-state: 'vocal' | 'instrumental' | null (not analysed for vocals).
        vocal: t.vocalRanges == null ? null : t.vocalRanges.length ? 'vocal' : 'instrumental',
      }));
    res.json({
      tracks,
      truncated,
      sampled,
      max,
      hardMax: OBSERVATORY_HARD_MAX,
      moodVocab: settings.SHOW_MOODS,
      stats: {
        total: stats.total,
        distinctArtists: stats.distinctArtists,
        byMood: stats.byMood,
        byEnergy: stats.byEnergy,
        byGenre: stats.byGenre,
        bySource: stats.bySource,
        withEmbedding: stats.withEmbedding,
        withAudioEmbedding: stats.withAudioEmbedding,
        updatedAt: stats.updatedAt,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /library/observatory/track/:id — the dossier detail for one node. The
// full record plus the lazily-loaded heavy bits the bulk endpoint skips:
// last.fm tags, lyric excerpt, the real text + audio embedding vectors (for
// the heatmap fingerprints), and `mixNext` — the nearest neighbours in text
// embedding space (real KNN, what the DJ would actually mix toward). All
// null-safe: missing analysis/embeddings/enrichment simply return null and the
// UI hides those sections.
// ---------------------------------------------------------------------------
router.get('/library/observatory/track/:id', requireAdmin, async (req, res) => {
  try {
    await library.load();
    const id = req.params.id;
    const t = db.getTrack(id);
    if (!t) return res.status(404).json({ error: 'track not found' });

    const textVec = db.getVector(id);
    const audioVec = db.getAudioVector(id);
    const mixNext = library
      .tracksLikeThis(id, 8)
      .map((n: any) => ({
        id: n.id,
        title: n.title,
        artist: n.artist,
        bpm: n.bpm ?? null,
        musicalKey: n.musicalKey ?? null,
        energy: n.energy ?? null,
        similarity: n._similarity ?? null,
      }));

    res.json({
      track: {
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        year: t.year,
        genre: t.genre,
        durationSec: t.durationSec,
        moods: t.moods,
        energy: t.energy,
        source: t.source,
        confidence: t.confidence,
        taggerVersion: t.taggerVersion,
        model: t.model,
        taggedAt: t.taggedAt,
        lastfmTags: t.lastfmTags,
        lyricExcerpt: t.lyricExcerpt,
        bpm: t.bpm,
        musicalKey: t.musicalKey,
        introMs: t.introMs,
        analysisConfidence: t.analysisConfidence,
        analysisVersion: t.analysisVersion,
        // Acoustic detail — the curves/ranges the dossier's SONG SHAPE timeline
        // draws. All null-safe; the UI hides what isn't computed. (beats/bars
        // are deliberately omitted — too granular/heavy for the payload.)
        loudnessLufs: t.loudnessLufs,
        peakDb: t.peakDb,
        structure: t.structure,
        vocalRanges: t.vocalRanges,
        pace: t.pace,
        keyRanges: t.keyRanges,
      },
      textEmbedding: textVec ? Array.from(textVec) : null,
      audioEmbedding: audioVec ? Array.from(audioVec) : null,
      mixNext,
    });
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
// GET /library/coverage —
//   { tagged, analysed, total, percent, analysedPercent, scannedAt, scanning }
// `total` / `percent` / `analysedPercent` are null until the first background
// scan completes.
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
// POST /library/analyze — kick off the standalone analysis pass as a
// background child (the admin "Analyze audio" button). Runs bpm/key/intro for
// un-analysed tracks and — when audio embeddings are enabled via the settings
// toggle or ANALYZE_AUDIO_EMBEDDING — backfills CLAP vectors for tracks that
// lack one (--audio). Shares the tagger's single-flight state: poll /settings
// (tagger.running / tagger.mode) for progress, stop via /tag-library/stop.
// ---------------------------------------------------------------------------
router.post('/library/analyze', requireAdmin, (req, res) => {
  if (tagger.running) return res.status(409).json({ error: 'a tagger/analyzer run is already active', tagger });
  const limit = parseIntSafe(req.body?.limit, null);
  startAnalyzer({ limit: limit ?? undefined, audio: true });
  res.json({ ok: true, tagger });
});

// ---------------------------------------------------------------------------
// POST /library/reconcile — walk Navidrome and prune library rows for tracks
// that no longer exist there (deleted files, or IDs re-minted by a full
// rescan). No LLM, no embeddings — the cheap "clear orphaned entries" path,
// usable even at 100% coverage where Start tagging is disabled. Shares the
// tagger's single-flight slot: poll /settings (tagger.running / tagger.mode ===
// 'reconcile') for progress, stop via /tag-library/stop.
// ---------------------------------------------------------------------------
router.post('/library/reconcile', requireAdmin, (req, res) => {
  if (tagger.running) return res.status(409).json({ error: 'a tagger/analyzer run is already active', tagger });
  startReconcile();
  res.json({ ok: true, tagger });
});

// ---------------------------------------------------------------------------
// POST /library/retag — single-track refresh through the bulk pipeline.
// Body: { id, title?, artist?, album?, year?, genre? }
//
// Goes through the same machinery as `npm run tag`:
//   1. Resolve metadata (body wins; falls back to Subsonic search).
//   2. Refresh enrichment (Last.fm tags + lyrics excerpt) per settings.
//   3. Re-embed with the current model so future propagation runs use a
//      fresh vector grounded in current metadata.
//   4. LLM-tag via tagBatch([song]) using the same batch prompt as bulk.
//
// We always go to the LLM here (not propagation) — "retag" semantically
// means "override what's there", and the operator is sitting in front of
// the UI waiting for a fresh decision. Embedding/enrichment updates are
// best-effort: a failure there logs and continues to the LLM step.
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

    const embedCfg: any = (settings.get() as any).embedding ?? {};
    const enrichCfg = embedCfg.enrichment ?? {};
    // Tri-state gate, shared with tag-library.phaseEnrich via lastfmEnrichEnabled:
    // explicit `true` always enriches; explicit `false` never does; the default
    // (unset) enriches when a Last.fm key is present. Previously a strict
    // `=== true` here, so a key-present-but-toggle-unset operator got tags from
    // the bulk tagger but not from single-track retag (issue #532).
    const lastfmEnabled = lastfm.lastfmEnrichEnabled(enrichCfg.lastfmTags, lastfm.hasLastfmKey());
    const lyricsEnabled = enrichCfg.lyrics !== false;

    // 1. Make sure the track row exists in library-db with current metadata so
    //    upsertTrackEnrichment / upsertTrackVector below have a row to attach to.
    db.upsertTrackMeta(id, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year ?? null,
      genre: song.genre ?? null,
    });

    // 2. Refresh enrichment (best-effort).
    let lastfmTags: string[] | null = null;
    let lyricExcerpt: string | null = null;
    if (lastfmEnabled && song.artist) {
      try {
        // Direct Last.fm API when a key is present (works on vanilla Navidrome),
        // else Navidrome's getArtistInfo2 — the same source the bulk tagger uses,
        // so single-track retag surfaces the same tags it would (issue #532).
        lastfmTags = await lastfm.getArtistTags(song.artist, { count: 10 });
      } catch (err: any) {
        queue.log('warn', `/library/retag enrich(lastfm) ${id}: ${err.message}`);
      }
    }
    if (lyricsEnabled) {
      try {
        const raw = await subsonic.getLyrics(id);
        if (typeof raw === 'string' && raw.trim()) lyricExcerpt = raw.trim();
      } catch (err: any) {
        queue.log('warn', `/library/retag enrich(lyrics) ${id}: ${err.message}`);
      }
    }
    if (lastfmEnabled || lyricsEnabled) {
      db.upsertTrackEnrichment(id, {
        lastfmTags: lastfmTags && lastfmTags.length ? lastfmTags : null,
        lyricExcerpt,
      });
    }

    // 3. Re-embed (best-effort — if embeddings are off or fail, fall through).
    if (embedCfg.enabled !== false && embeddings.isAvailable()) {
      try {
        const text = embeddings.formatTrackText(
          {
            title: song.title,
            artist: song.artist,
            album: song.album,
            year: song.year ?? null,
            genre: song.genre ?? null,
          },
          { lastfmTags, lyricExcerpt },
        );
        const [vec] = await embeddings.embedTexts([text]);
        if (vec) db.upsertTrackVector(id, vec);
      } catch (err: any) {
        queue.log('warn', `/library/retag embed ${id}: ${err.message}`);
      }
    }

    // 4. LLM tag through the same batch path the bulk pipeline uses.
    const [{ moods, energy }] = await tagBatch([song]);
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
// POST /library/manual-tag — operator-set tags, no LLM involved.
// Body: { id, moods: string[], energy?: 'low'|'medium'|'high'|null,
//         applyToAlbum?: boolean }
//
// `moods: []` clears the tags entirely (track returns to the untagged pool).
// `applyToAlbum` resolves the whole album server-side from the track id
// (subsonic.getSong → albumId → getAlbum) and applies the same tags to every
// track — this is the "tag an album/folder for targeted queuing" path
// (discussion #336). Moods are restricted to settings.SHOW_MOODS so manual
// rows feed songsByMood()/MOOD_NEIGHBOURS exactly like LLM-tagged ones.
// ---------------------------------------------------------------------------
router.post('/library/manual-tag', requireAdmin, async (req, res) => {
  const id = req.body?.id;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
  const moods = req.body?.moods;
  if (!Array.isArray(moods) || moods.some((m: any) => typeof m !== 'string')) {
    return res.status(400).json({ error: 'moods must be an array of strings' });
  }
  if (moods.length > 3) return res.status(400).json({ error: 'at most 3 moods per track' });
  const unknown = moods.filter((m: string) => !settings.SHOW_MOODS.includes(m));
  if (unknown.length) {
    return res.status(400).json({ error: `unknown mood(s): ${unknown.join(', ')}` });
  }
  const energy = req.body?.energy ?? null;
  if (energy !== null && !['low', 'medium', 'high'].includes(energy)) {
    return res.status(400).json({ error: "energy must be 'low', 'medium', 'high' or null" });
  }
  const applyToAlbum = req.body?.applyToAlbum === true;
  const clearing = moods.length === 0;

  try {
    await library.load();

    // Resolve the seed track — Subsonic first (carries albumId), library-db
    // row as fallback so already-indexed tracks work even if Navidrome misses.
    let song: any = null;
    try { song = await subsonic.getSong(id); } catch {}
    if (!song) {
      const row = db.getTrack(id);
      if (row) song = { id: row.id, title: row.title, artist: row.artist, album: row.album, year: row.year, genre: row.genre, duration: row.durationSec };
    }
    if (!song) return res.status(404).json({ error: 'track not found' });

    let targets: any[] = [song];
    if (applyToAlbum) {
      if (!song.albumId) return res.status(404).json({ error: 'album not resolvable for this track' });
      targets = await subsonic.getAlbum(song.albumId);
      if (!targets.length) return res.status(404).json({ error: 'album has no tracks' });
    }

    for (const t of targets) {
      // Album siblings may be brand-new to library-db — make sure a row exists
      // before tagging it.
      db.upsertTrackMeta(t.id, {
        title: t.title,
        artist: t.artist,
        album: t.album,
        year: t.year ?? null,
        genre: t.genre ?? null,
        duration: t.duration ?? null,
      });
      if (clearing) {
        db.clearTrackTags(t.id);
      } else {
        db.upsertTrackTags(t.id, {
          moods,
          energy,
          source: 'manual',
          confidence: 1,
        });
      }
    }
    await library.save();

    const scope = applyToAlbum ? `album "${song.album}" (${targets.length} tracks)` : `"${song.title}"`;
    queue.log('info', clearing
      ? `manual-tag: cleared tags on ${scope}`
      : `manual-tag: ${scope} → [${moods.join(', ')}] energy=${energy ?? '—'}`);

    res.json({
      ok: true,
      updated: targets.length,
      cleared: clearing,
      album: applyToAlbum ? (song.album ?? null) : null,
      tracks: targets.map(t => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        moods: clearing ? [] : moods,
        energy: clearing ? null : energy,
      })),
    });
  } catch (err: any) {
    queue.log('error', `/library/manual-tag failed: ${err.message}`);
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
