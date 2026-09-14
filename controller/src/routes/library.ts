// Admin-gated music-library management surface — backs /admin/library.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as library from '../music/library.js';
import * as blocklist from '../music/blocklist.js';
import * as likes from '../broadcast/likes.js';
import * as db from '../music/library-db.js';
import * as analyzer from '../music/analyzer.js';
import * as coverage from '../music/library-coverage.js';
import * as subsonic from '../music/subsonic.js';
import * as sceneVocab from '../music/scene-vocab.js';
import { sceneReferences } from '../music/scene-references.js';
import * as lastfm from '../music/lastfm.js';
import * as musicbrainz from '../music/musicbrainz.js';
import * as settings from '../settings.js';
import * as embeddings from '../music/embeddings.js';
import { resolveEraYear } from '../music/show-filter.js';
import { isInstrumental } from '../music/lyric-vocal.js';
import { soundKnnWidth } from '../util/similar-tracks.js';
import { buildGenreSuggest } from '../music/genre-suggest.js';
import { tagBatch, TAGGER_CONTRACT_VERSION } from '../music/tagger-core.js';
import { promptVocabHash } from '../music/embeddings.js';
import { activeModelLabel } from '../llm/provider.js';
import { queue } from '../broadcast/queue.js';
import { tagger, taggerView, startAnalyzer, startReconcile } from '../broadcast/tagger.js';
import { refreshAutoPlaylist } from '../broadcast/scheduler.js';
import * as mapProjection from '../music/map-projection.js';
import { validateBody, validateBodyAsync } from '../middleware/validate.js';
import { blockEntrySchema, blockRuleSchema } from '../schemas/blocklist.js';
import { manualTagSchema, originalYearSchema, sceneMergeSchema } from '../schemas/library.js';
import type { z } from 'zod';

type ManualTagBody = z.output<ReturnType<typeof manualTagSchema>>;
type OriginalYearBody = z.output<ReturnType<typeof originalYearSchema>>;
type SceneMergeBody = z.output<ReturnType<typeof sceneMergeSchema>>;

export const router = express.Router();

interface LibrarySong {
  id: string;
  albumId?: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
  originalYear?: number | null;
  originalYearSource?: string | null;
  isCompilation?: boolean | null;
  eraUntrusted?: boolean | null;
  genre?: string | null;
  duration?: number | null;
}

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

// Scene vocabulary (#1577): the genre tag set as one curatable list. Counts
// come from the mirror, not Navidrome's genre index, so every value listed is
// one a merge can reach. A full json_each walk of `tracks`, so never polled.

const SCENE_REFERENCES_LOGGED = 5;

function sceneListing() {
  return { scenes: library.scenes(), aliases: sceneVocab.list() };
}

router.get('/library/scenes', requireAdmin, async (_req, res) => {
  try {
    await library.load();
    res.json(sceneListing());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The referenced-by warning (#1593), asked BEFORE the merge. Same body and
// same call as the merge, so preview and merge cannot disagree.
router.post(
  '/library/scenes/references',
  requireAdmin,
  validateBody(sceneMergeSchema(), { messages: 'verbatim' }),
  async (req, res) => {
    const { from, to } = req.body as SceneMergeBody;
    try {
      res.json({ references: await sceneReferences(from, to) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  '/library/scenes/merge',
  requireAdmin,
  validateBody(sceneMergeSchema(), { messages: 'verbatim' }),
  async (req, res) => {
    const { from, to } = req.body as SceneMergeBody;
    try {
      await library.load();
      // Computed BEFORE the rewrite: the target resolves through the rule set this
      // merge is about to change.
      const references = await sceneReferences(from, to);
      const result = await library.consolidateScenes(from, to);
      // Three outcomes: rows rewritten; no rows but a rule recorded; nothing to do
      // (a 200 with zero counts, which must not claim a rule was recorded).
      queue.log(
        'info',
        result.tracksChanged > 0
          ? `scenes: merged ${result.sources.map(s => `"${s}"`).join(', ')} → "${result.target}" (${result.tracksChanged} track${result.tracksChanged === 1 ? '' : 's'})`
          : result.recorded.length > 0
            ? `scenes: nothing to rewrite for "${result.target}" — rule recorded for the next library scan`
            : `scenes: nothing to do — "${result.target}" already survives every value picked`,
      );
      // Named, not counted, so the log still explains a show that airs nothing.
      if (references.length) {
        const named = references
          .slice(0, SCENE_REFERENCES_LOGGED)
          .map(r => `${r.kind} "${r.name}" (${r.orphaned.map(v => `"${v}"`).join(', ')})`);
        const rest = references.length - named.length;
        queue.log(
          'warn',
          `scenes: merging into "${result.target}" retires values still filtered by ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''} — repoint them by hand`,
        );
      }
      res.json({
        ok: true,
        target: result.target,
        sources: result.sources,
        recorded: result.recorded,
        tracksChanged: result.tracksChanged,
        vectorsDirtied: result.vectorsDirtied,
        // Filters that named a retired value and now match nothing. A warning, never
        // a block.
        references,
        ...sceneListing(),
      });
    } catch (err) {
      queue.log('error', `/library/scenes/merge failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  },
);

// Forgetting a rule stops it applying to FUTURE walks; rows it already rewrote
// keep the merged value and cannot be restored. The UI says this on the button.
router.delete('/library/scenes/aliases/:from', requireAdmin, async (req, res) => {
  try {
    const removed = await sceneVocab.forget(req.params.from);
    if (!removed) return res.status(404).json({ error: 'no such scene rule' });
    queue.log('info', `scenes: dropped the rule for "${req.params.from}"`);
    // Aliases only: no row is rewritten, so the client's counts are still
    // correct and a rescan would be a full table walk for an unchanged answer.
    res.json({ ok: true, aliases: sceneVocab.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk dataset behind the Library Observatory: every tagged track projected to
// what the map/tooltip/filters need, heavy fields lazy from /track/:id. Above
// `max` a stratified per-genre sample is returned. Archive rows dropped (#273).
// The web client sends no ?max= until the operator picks one, so this default
// also governs the UI (echoed back as `defaultMax`). 500k is stress-verified
// but ~190 MB raw, so the ceiling stays opt-in headroom.
const OBSERVATORY_DEFAULT_MAX = Math.max(500, Number(process.env.OBSERVATORY_MAX) || 25000);
const OBSERVATORY_HARD_MAX = Math.max(OBSERVATORY_DEFAULT_MAX, Number(process.env.OBSERVATORY_HARD_MAX) || 500000);
router.get('/library/observatory', requireAdmin, async (req, res) => {
  try {
    await library.load();
    const requested = Number(req.query.max);
    const max = Math.min(
      OBSERVATORY_HARD_MAX,
      Math.max(500, Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : OBSERVATORY_DEFAULT_MAX),
    );

    // The payload is a pure function of library rows + max, so a token changing on
    // any library write is a sound ETag; the projection-running flag rides in it
    // too. Checked BEFORE stats(), which is itself a long scan.
    const etag = `W/"obs-${db.changeToken()}-${max}-${mapProjection.projectionStatus().running ? 1 : 0}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((v) => v.trim() === etag)) {
      return res.status(304).end();
    }

    const stats = library.stats();
    const total = stats.total;
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
        genres: t.genres,
        genre: t.genre,
        durationSec: t.durationSec,
        moods: t.moods,
        energy: t.energy,
        source: t.source,
        confidence: t.confidence,
        bpm: t.bpm,
        musicalKey: t.musicalKey,
        analysisConfidence: t.analysisConfidence,
        loudnessLufs: t.loudnessLufs,
        paceMean: t.paceMean,
        vocal: t.vocal,
        // UMAP of the CLAP vector, [0,1] per axis; null falls back to genre clusters.
        mapX: t.mapX,
        mapY: t.mapY,
      }));
    res.json({
      tracks,
      truncated,
      sampled,
      max,
      defaultMax: OBSERVATORY_DEFAULT_MAX,
      hardMax: OBSERVATORY_HARD_MAX,
      mapProjection: mapProjection.projectionStatus(),
      moodVocab: settings.moodVocab(),
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dossier for one node: the full record plus the heavy bits the bulk endpoint
// skips, and `mixNext`, the text-space KNN. All null-safe.
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
      .map((n) => ({
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
        genres: t.genres,
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
        loudnessLufs: t.loudnessLufs,
        peakDb: t.peakDb,
        structure: t.structure,
        vocalRanges: t.vocalRanges,
        pace: t.pace,
        keyRanges: t.keyRanges,
        audioMoods: t.audioMoods,
        audioMoodScores: db.getAudioMoodScores(id),
        // beats/bars stripped like the main grid.
        outro: t.outro
          ? { startMs: t.outro.startMs, ending: t.outro.ending, lufs: t.outro.lufs, bpm: t.outro.bpm }
          : null,
      },
      textEmbedding: textVec ? Array.from(textVec) : null,
      audioEmbedding: audioVec ? Array.from(audioVec) : null,
      mixNext,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sound-map job status alone, pollable without the multi-MB track body.
router.get('/library/observatory/projection', requireAdmin, async (_req, res) => {
  try {
    await library.load();
    res.json(mapProjection.projectionStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force a sound-map projection pass now. 409 if one is running; minutes-long,
// so the client polls the projection route for completion.
router.post('/library/observatory/project', requireAdmin, async (_req, res) => {
  try {
    await library.load();
    const started = mapProjection.startProjection();
    res.status(started ? 202 : 409).json({ started, status: mapProjection.projectionStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// `cursor` is an opaque base64 of `albumOffset:songIndexInAlbum`; nextCursor is
// null at the end of the walk.
router.get('/library/untagged', requireAdmin, async (req, res) => {
  await library.load();
  const limit = Math.min(Math.max(parseIntSafe(req.query?.limit, 50) ?? 50, 1), 100);
  const cursor = decodeCursor(typeof req.query?.cursor === 'string' ? req.query.cursor : '');
  const startAlbumOffset = cursor.albumOffset;
  const startSongIndex = cursor.songIndex;

  const rows: LibrarySong[] = [];
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
        let songs: LibrarySong[] = [];
        try { songs = await subsonic.getAlbum(album.id); } catch { songs = []; }
        for (let j = (i === 0 ? songIndex : 0); j < songs.length; j++) {
          const s = songs[j];
          visited++;
          if (library.has(s.id)) continue;
          const era = library.get(s.id);
          rows.push({
            id: s.id,
            title: s.title,
            artist: s.artist,
            album: s.album,
            year: s.year ?? null,
            originalYear: era?.originalYear ?? null,
            originalYearSource: era?.originalYearSource ?? null,
            isCompilation: era?.isCompilation ?? null,
            eraUntrusted: era?.eraUntrusted ?? null,
            genre: s.genre ?? null,
            duration: s.duration ?? null,
          });
          if (rows.length >= limit) {
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
    res.json({ rows: blocklist.annotate(rows), nextCursor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DB counts plus the LAST-KNOWN Navidrome total (null until someone has asked
// for a count). Never walks Navidrome; counting is the POST below (#1570).
router.get('/library/coverage', requireAdmin, async (_req, res) => {
  try {
    res.json(await coverage.get());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The operator's "Count library" button. A POST because it walks every album;
// returns at once with the pre-scan snapshot, which the caller polls.
router.post('/library/coverage/refresh', requireAdmin, async (_req, res) => {
  try {
    // Fire-and-forget: doScan() swallows its own failure and outlives any
    // sensible request timeout.
    coverage.refresh();
    res.json({ ok: true, coverage: await coverage.get() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tracks acoustic analysis threw on, worst and most recent first. `excluded`
// counts the ones that have left every analysis scope (#1300).
router.get('/library/analysis-failures', requireAdmin, (req, res) => {
  try {
    const limit = parseIntSafe(req.query?.limit, 200);
    res.json({
      failures: db.analysisFailures(Math.min(1000, Math.max(1, limit))),
      excluded: db.analysisFailedCount(),
      maxAttempts: db.MAX_ANALYSIS_FAILURES,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forget the failure history so the next pass retries. `{ id }` clears one
// track; no body clears all.
router.post('/library/analysis-failures/clear', requireAdmin, (req, res) => {
  try {
    const id = typeof req.body?.id === 'string' && req.body.id ? req.body.id : undefined;
    res.json({ ok: true, cleared: db.clearAnalysisFailures(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The tagger snapshot alone (same slicing as /settings' `tagger`), polled on the
// admin panel's fast loop so progress doesn't drag the heavy /settings payload.
router.get('/library/tagger', requireAdmin, (_req, res) => {
  res.json({ tagger: taggerView() });
});

// The admin "Analyze audio" button: bpm/key/intro plus CLAP vector backfill.
// Shares the tagger's single-flight state; stop via /tag-library/stop.
router.post('/library/analyze', requireAdmin, (req, res) => {
  if (tagger.running) return res.status(409).json({ error: 'a tagger/analyzer run is already active', tagger });
  const limit = parseIntSafe(req.body?.limit, null);
  // `vocal:true` (#646) forces the Demucs vocal pass; a vocal run leaves audio at
  // its env default so the two backfills stay independently triggerable.
  const vocal = req.body?.vocal === true;
  startAnalyzer({ limit: limit ?? undefined, audio: vocal ? undefined : true, vocal: vocal || undefined });
  res.json({ ok: true, tagger });
});

// Walk Navidrome and prune rows for tracks that no longer exist there. Usable
// at 100% coverage; shares the tagger's single-flight slot.
router.post('/library/reconcile', requireAdmin, (req, res) => {
  if (tagger.running) return res.status(409).json({ error: 'a tagger/analyzer run is already active', tagger });
  startReconcile();
  res.json({ ok: true, tagger });
});

// Delete library.db entirely and reopen an empty one; coverage's Navidrome
// `total` is untouched. Refused while a run holds the single-flight slot,
// since deleting the file under the child would corrupt it.
router.post('/library/reset', requireAdmin, async (_req, res) => {
  if (tagger.running) return res.status(409).json({ error: 'a tagger/analyzer run is already active', tagger });
  try {
    await library.reset();
    // No coverage.refresh() here: a reset wipes library.db, not the music
    // server, so the only figure refresh() recomputes cannot have changed.
    queue.log('warn', 'library reset: wiped all tagging data (tags, embeddings, acoustics, enrichment)');
    res.json({ ok: true });
  } catch (err) {
    queue.log('error', `/library/reset failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Single-track refresh through the bulk pipeline: resolve metadata (body wins)
// → refresh enrichment → re-embed → tagBatch([song]). Always the LLM, never
// propagation; the enrichment/embedding steps are best-effort.
router.post('/library/retag', requireAdmin, async (req, res) => {
  const id = req.body?.id;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
  try {
    await library.load();
    let song = req.body || {};
    if (!song.title || !song.artist) {
      const found = await subsonic.search(`${song.title || ''} ${song.artist || ''}`.trim() || id, { songCount: 25 });
      const hit = (found || []).find((s) => s.id === id);
      if (hit) song = { ...hit, ...song };
    }
    if (!song.title) return res.status(404).json({ error: 'track metadata not found' });

    const embedCfg = settings.get().embedding ?? {};
    const enrichCfg = embedCfg.enrichment ?? {};
    // Tri-state gate shared with tag-library.phaseEnrich: true always enriches,
    // false never, unset enriches when a Last.fm key is present (#532).
    const lastfmEnabled = lastfm.lastfmEnrichEnabled(enrichCfg.lastfmTags, lastfm.hasLastfmKey());
    const lyricsEnabled = enrichCfg.lyrics !== false;

    // 1. Ensure the track row exists so the upserts below have a row to attach to.
    db.upsertTrackMeta(id, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year ?? null,
      genres: subsonic.songGenres(song),
    });

    let lastfmTags: string[] | null = null;
    let lyricExcerpt: string | null = null;
    if (lastfmEnabled && song.artist) {
      try {
        // Same source as the bulk tagger: direct Last.fm when a key is present,
        // else Navidrome's getArtistInfo2 (#532).
        lastfmTags = await lastfm.getArtistTags(song.artist, { count: 10 });
      } catch (err) {
        queue.log('warn', `/library/retag enrich(lastfm) ${id}: ${err.message}`);
      }
    }
    if (lyricsEnabled) {
      try {
        const raw = await subsonic.getLyrics(id);
        if (typeof raw === 'string' && raw.trim()) lyricExcerpt = raw.trim();
      } catch (err) {
        queue.log('warn', `/library/retag enrich(lyrics) ${id}: ${err.message}`);
      }
    }
    if (lastfmEnabled || lyricsEnabled) {
      db.upsertTrackEnrichment(id, {
        lastfmTags: lastfmTags && lastfmTags.length ? lastfmTags : null,
        lyricExcerpt,
      });
    }

    // 2b. Refresh the original-year resolution (best-effort, #842). Retag counts as
    // an explicit refresh, so a prior miss is retried.
    if (enrichCfg.originalYear !== false) {
      try {
        const t = db.getTrack(id);
        if (t && musicbrainz.needsOriginalYearLookup(t, true)) {
          const year = await musicbrainz.lookupOriginalYear({
            title: song.title,
            artist: song.artist,
            mbid: song.musicBrainzId || null,
            year: Number(song.year) || null,
          });
          db.setOriginalYear(id, year);
        }
      } catch (err) {
        queue.log('warn', `/library/retag enrich(originalYear) ${id}: ${err.message}`);
      }
    }

    // 3. Re-embed (best-effort).
    if (embedCfg.enabled !== false && embeddings.isAvailable()) {
      try {
        // Same acoustics + era inputs as the bulk path (#1246): this must
        // produce the SAME text phaseEmbed would, or the track drifts in KNN space.
        const rec = db.getTrack(id);
        const eraYear = resolveEraYear(
          rec?.year ?? song.year, rec?.originalYear ?? null, rec?.yearUntrusted ?? null,
        );
        const text = embeddings.formatTrackText(
          {
            title: song.title,
            artist: song.artist,
            album: song.album,
            year: song.year ?? null,
            genres: subsonic.songGenres(song),
            eraYear,
          },
          { lastfmTags, lyricExcerpt },
          rec
            ? {
                bpm: rec.bpm, musicalKey: rec.musicalKey, audioMoods: rec.audioMoods,
                vocalRanges: rec.vocalRanges,
              }
            : null,
        );
        // Must match the task-prefix mode the rest of the index was built in.
        const textMode = embeddings.resolveIndexTextMode(
          db.getEmbeddingMeta()?.textMode,
          db.vectorCount(),
        );
        const [vec] = await embeddings.embedDocTexts([text], textMode);
        if (vec) db.upsertTrackVector(id, vec, eraYear);
      } catch (err) {
        queue.log('warn', `/library/retag embed ${id}: ${err.message}`);
      }
    }

    const [{ moods, energy }] = await tagBatch([song]);
    library.set(id, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year,
      genres: subsonic.songGenres(song),
      moods,
      energy,
      source: 'llm',
      promptHash: promptVocabHash(TAGGER_CONTRACT_VERSION),
      model: activeModelLabel(),
    });
    await library.save();
    const tagged = library.get(id);
    res.json({ id, moods, energy, taggedAt: tagged?.taggedAt });
  } catch (err) {
    queue.log('error', `/library/retag failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Operator-set tags, no LLM. `moods: []` clears them; `applyToAlbum` resolves
// the album server-side and tags every track (#336). Moods are restricted to
// the live vocabulary so manual rows feed songsByMood() like LLM-tagged ones.
router.post(
  '/library/manual-tag',
  requireAdmin,
  // The mood vocabulary is operator-editable, so the schema cannot exist until
  // the request does.
  validateBodyAsync(() => manualTagSchema({ moodNames: settings.moodVocab() }), {
    messages: 'verbatim',
  }),
  async (req, res) => {
    const { id, moods, energy, applyToAlbum } = req.body as ManualTagBody;
    const clearing = moods.length === 0;

    try {
      await library.load();

      // Subsonic first (carries albumId), library-db row as fallback.
      let song: LibrarySong | null = null;
      try { song = await subsonic.getSong(id); } catch {}
      if (!song) {
        const row = db.getTrack(id);
        if (row) song = { id: row.id, title: row.title, artist: row.artist, album: row.album, year: row.year, genre: row.genre, duration: row.durationSec };
      }
      if (!song) return res.status(404).json({ error: 'track not found' });

      let targets: LibrarySong[] = [song];
      if (applyToAlbum) {
        if (!song.albumId) return res.status(404).json({ error: 'album not resolvable for this track' });
        targets = await subsonic.getAlbum(song.albumId);
        if (!targets.length) return res.status(404).json({ error: 'album has no tracks' });
      }

      for (const t of targets) {
        // An album sibling may be new to library-db; the row has to exist first.
        db.upsertTrackMeta(t.id, {
          title: t.title,
          artist: t.artist,
          album: t.album,
          year: t.year ?? null,
          genres: subsonic.songGenres(t),
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
    } catch (err) {
      queue.log('error', `/library/manual-tag failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  },
);

// The operator's manual era override (#1418). Automatic resolution only runs for
// albums Navidrome flags as compilations, which reissue anthologies do not set.
// `originalYear: null` clears the override and returns the track to automatic.
router.post(
  '/library/original-year',
  requireAdmin,
  // The factory form, not a schema built once at module load: the upper bound
  // is "next year", so a long-running controller must not freeze it in December.
  validateBodyAsync(() => originalYearSchema(), { messages: 'verbatim' }),
  async (req, res) => {
    const { id, originalYear, applyToAlbum } = req.body as OriginalYearBody;

    try {
      await library.load();

      // Subsonic first (albumId), then the library-db row.
      let song: LibrarySong | null = null;
      try { song = await subsonic.getSong(id); } catch {}
      if (!song) {
        const row = db.getTrack(id);
        if (row) song = { id: row.id, title: row.title, artist: row.artist, album: row.album, year: row.year, genre: row.genre, duration: row.durationSec };
      }
      if (!song) return res.status(404).json({ error: 'track not found' });

      let targets: LibrarySong[] = [song];
      if (applyToAlbum) {
        if (!song.albumId) return res.status(404).json({ error: 'album not resolvable for this track' });
        targets = await subsonic.getAlbum(song.albumId);
        if (!targets.length) return res.status(404).json({ error: 'album has no tracks' });
      }

      for (const t of targets) {
        db.upsertTrackMeta(t.id, {
          title: t.title,
          artist: t.artist,
          album: t.album,
          year: t.year ?? null,
          genres: subsonic.songGenres(t),
          duration: t.duration ?? null,
        });
        db.setManualOriginalYear(t.id, originalYear);
      }

      const scope = applyToAlbum ? `album "${song.album}" (${targets.length} tracks)` : `"${song.title}"`;
      queue.log('info', originalYear == null
        ? `original-year: cleared the override on ${scope} — back to automatic resolution`
        : `original-year: ${scope} → ${originalYear}`);

      res.json({
        ok: true,
        updated: targets.length,
        originalYear,
        cleared: originalYear == null,
        album: applyToAlbum ? (song.album ?? null) : null,
        tracks: targets.map((t) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          year: t.year ?? null,
          // Echoed back so the editor shows the effect rather than the input.
          eraYear: db.resolvedEraYearForTrack(t.id),
        })),
      });
    } catch (err) {
      queue.log('error', `/library/original-year failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  },
);

// Never-play blocklist at track/album/artist granularity. Enforcement lives in
// music/blocklist.ts; these routes only manage the list.

router.get('/library/blocklist', requireAdmin, (_req, res) => {
  // Rules ride the same listing with live stats: `active` (blocking right now) and
  // `matchCount` (library-wide reach, so a typo'd value reads 0).
  let rules: ReturnType<typeof blocklist.rulesWithStats> = [];
  if (blocklist.listRules().length) {
    let rows: any[] = [];
    try { rows = db.ruleMatchRows(); } catch {}
    rules = blocklist.rulesWithStats(rows);
  }
  res.json({ entries: blocklist.list(), rules });
});

// Rule entries (#1300). Registered BEFORE the entry routes: DELETE
// /library/blocklist/:type/:id would otherwise swallow /rules/:id with
// type='rules'. Same schema blocklist.addRule reaches via validateRulePatch.
router.post(
  '/library/blocklist/rules',
  requireAdmin,
  validateBody(blockRuleSchema, { messages: 'verbatim' }),
  async (req, res) => {
  try {
    const rule = await blocklist.addRule(req.body);
    queue.log('blocked', `rule "${rule.label}" (${rule.field}: ${rule.values.join(', ')}) added to the never-play blocklist`);
    // Same side-effects as adding an id entry: drop now-blocked upcoming tracks,
    // rebuild auto.m3u so the LLM-free coast stops carrying them.
    const purged = queue.purgeBlocked();
    refreshAutoPlaylist().catch((err: any) => queue.log('error', `blocklist auto-playlist refresh failed: ${err.message}`));
    res.status(201).json({ rule, purged });
  } catch (err) {
    // Validation errors are the operator's typo, not a server fault.
    res.status(400).json({ error: err.message });
  }
  },
);

router.put(
  '/library/blocklist/rules/:id',
  requireAdmin,
  validateBody(blockRuleSchema, { messages: 'verbatim' }),
  async (req, res) => {
  try {
    const rule = await blocklist.updateRule(String(req.params.id), req.body);
    if (!rule) return res.status(404).json({ error: 'no such rule' });
    queue.log('blocked', `rule "${rule.label}" updated on the never-play blocklist`);
    const purged = queue.purgeBlocked();
    refreshAutoPlaylist().catch((err: any) => queue.log('error', `blocklist auto-playlist refresh failed: ${err.message}`));
    res.json({ rule, purged });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
  },
);

router.delete('/library/blocklist/rules/:id', requireAdmin, async (req, res) => {
  try {
    const removed = await blocklist.removeRule(req.params.id);
    if (!removed) return res.status(404).json({ error: 'no such rule' });
    queue.log('blocked', `rule ${req.params.id} removed from the never-play blocklist`);
    // No purge on remove: auto.m3u picks the track back up on its next refresh.
    res.status(204).end();
  } catch (err) {
    queue.log('error', `/library/blocklist/rules delete failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Body is either { type, trackId } (server resolves album/artist ids and display
// snapshots) or a pre-resolved { type, id, name?, artist?, album? }.
router.post(
  '/library/blocklist',
  requireAdmin,
  // Shape only: resolving `{type, trackId}` needs Subsonic, so which form
  // arrived is decided below.
  validateBody(blockEntrySchema, { messages: 'verbatim' }),
  async (req, res) => {
  const type = req.body.type;
  try {
    let input: { type: blocklist.BlockType; id: string; name?: string | null; artist?: string | null; album?: string | null };
    const trackId = req.body?.trackId;
    if (trackId && typeof trackId === 'string') {
      // Subsonic first (carries albumId/artistId), library-db fallback.
      let song: any = null;
      try { song = await subsonic.getSong(trackId); } catch {}
      if (!song) {
        const row = db.getTrack(trackId);
        if (row && type === 'track') song = { id: row.id, title: row.title, artist: row.artist, album: row.album };
      }
      if (!song) return res.status(404).json({ error: 'track not found' });
      if (type === 'track') {
        input = { type, id: song.id, name: song.title ?? null, artist: song.artist ?? null, album: song.album ?? null };
      } else if (type === 'album') {
        if (!song.albumId) return res.status(404).json({ error: 'album not resolvable for this track' });
        input = { type, id: song.albumId, name: song.album ?? null, artist: song.artist ?? null };
      } else {
        if (!song.artistId) return res.status(404).json({ error: 'artist not resolvable for this track' });
        input = { type, id: song.artistId, name: song.artist ?? null };
      }
    } else {
      const id = req.body?.id;
      if (!id || typeof id !== 'string') return res.status(400).json({ error: 'trackId or id is required' });
      input = { type, id, name: req.body?.name ?? null, artist: req.body?.artist ?? null, album: req.body?.album ?? null };
    }

    const entry = await blocklist.add(input);
    if (!entry) return res.status(409).json({ error: 'already blocked' });

    queue.log('blocked', `${entry.type} "${entry.name ?? entry.id}"${entry.artist && entry.type !== 'artist' ? ` — ${entry.artist}` : ''} added to the never-play blocklist`);
    // Rebuild auto.m3u too, or a blocked track still airs from it for up to
    // autoQueueRefreshMinutes.
    const purged = queue.purgeBlocked();
    refreshAutoPlaylist().catch((err: any) => queue.log('error', `blocklist auto-playlist refresh failed: ${err.message}`));

    res.status(201).json({ entry, purged });
  } catch (err) {
    queue.log('error', `/library/blocklist failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
  },
);

router.delete('/library/blocklist/:type/:id', requireAdmin, async (req, res) => {
  const { type, id } = req.params;
  if (!['track', 'album', 'artist'].includes(type)) {
    return res.status(400).json({ error: "type must be 'track', 'album' or 'artist'" });
  }
  try {
    const removed = await blocklist.remove(type as blocklist.BlockType, id);
    if (!removed) return res.status(404).json({ error: 'not on the blocklist' });
    queue.log('blocked', `${type} ${id} removed from the never-play blocklist`);
    res.status(204).end();
  } catch (err) {
    queue.log('error', `/library/blocklist delete failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Bulk unblock: one rewrite and one persist, since N concurrent single DELETEs
// would race on the async write. Reports removed + missing.
const BULK_UNBLOCK_MAX = 500;

router.delete('/library/blocklist', requireAdmin, async (req, res) => {
  const raw = req.body?.entries;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'entries must be a non-empty array of { type, id }' });
  }
  if (raw.length > BULK_UNBLOCK_MAX) {
    return res.status(400).json({ error: `at most ${BULK_UNBLOCK_MAX} entries per call` });
  }
  const targets: Array<{ type: blocklist.BlockType; id: string }> = [];
  for (const e of raw) {
    const type = e?.type;
    const id = e?.id;
    if (!['track', 'album', 'artist'].includes(type) || typeof id !== 'string' || !id) {
      return res.status(400).json({ error: 'each entry needs a valid type and id' });
    }
    targets.push({ type, id });
  }
  try {
    const { removed, missing } = await blocklist.removeMany(targets);
    if (removed) {
      queue.log('blocked', `${removed} entr${removed === 1 ? 'y' : 'ies'} removed from the never-play blocklist`);
    }
    res.json({ removed, missing });
  } catch (err) {
    queue.log('error', `/library/blocklist bulk delete failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Re-marks rows already on screen; matching client-side would duplicate the
// normalised-name rules in music/blocklist.ts.
const BLOCK_CHECK_MAX = 500;

router.post('/library/blocklist/check', requireAdmin, (req, res) => {
  const rows = req.body?.tracks;
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: 'tracks must be an array' });
  }
  if (rows.length > BLOCK_CHECK_MAX) {
    return res.status(400).json({ error: `at most ${BLOCK_CHECK_MAX} tracks per call` });
  }
  const blocked: Record<string, blocklist.BlockRef | null> = {};
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== 'string' || !id) continue;
    // hitOf covers rules too: tag fields absent from the slim payload resolve
    // through the library lookup inside the show-filter readers.
    blocked[id] = blocklist.hitOf(row);
  }
  res.json({ blocked });
});

function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => parseList(x));
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function parseIntSafe<T extends number | null>(v: unknown, dflt: T): number | T {
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
