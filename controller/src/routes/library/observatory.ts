import express from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import * as library from '../../music/library.js';
import * as db from '../../music/library-db.js';
import * as subsonic from '../../music/subsonic.js';
import * as settings from '../../settings.js';
import * as mapProjection from '../../music/map-projection.js';

export const router = express.Router();

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
