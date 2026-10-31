import express from 'express';
import path from 'node:path';
import { requireAdmin } from '../../middleware/auth.js';
import * as library from '../../music/library.js';
import * as blocklist from '../../music/blocklist.js';
import * as db from '../../music/library-db.js';
import * as coverage from '../../music/library-coverage.js';
import * as subsonic from '../../music/subsonic.js';
import * as lastfm from '../../music/lastfm.js';
import * as musicbrainz from '../../music/musicbrainz.js';
import * as settings from '../../settings.js';
import * as embeddings from '../../music/embeddings.js';
import { resolveEraYear } from '../../music/show-filter.js';
import { tagBatch, TAGGER_CONTRACT_VERSION } from '../../music/tagger-core.js';
import { promptVocabHash } from '../../music/embeddings.js';
import { activeModelLabel } from '../../llm/provider.js';
import { queue } from '../../broadcast/queue.js';
import {
  tagger, taggerView, startAnalyzer, startReconcile, taggerLogSince, taggerLogFiles, taggerLogFile,
} from '../../broadcast/tagger.js';
import { validateBodyAsync } from '../../middleware/validate.js';
import { manualTagSchema, originalYearSchema } from '../../schemas/library.js';
import { z } from 'zod';
import { canonicalLanguage } from '../../music/request-normalize.js';
import { LANGUAGE_TAG_CONTRACT_VERSION } from '../../music/language-tagger.js';
import { isInstrumental } from '../../music/lyric-vocal.js';
import { parseIntSafe, encodeCursor, decodeCursor } from './params.js';

type ManualTagBody = z.output<ReturnType<typeof manualTagSchema>>;
type OriginalYearBody = z.output<ReturnType<typeof originalYearSchema>>;
const manualLanguageSchema = z.object({
  id: z.string().min(1, 'id is required'),
  language: z.preprocess(
    value => value === null ? null : typeof value === 'string' ? value.trim() : value,
    z.string().min(1, 'language is required').max(80, 'language is too long').nullable(),
  ),
  applyToAlbum: z.unknown().optional().transform(value => value === true),
});
type ManualLanguageBody = z.output<typeof manualLanguageSchema>;
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
  language?: unknown;
  languages?: string[];
  duration?: number | null;
  moods?: string[];
  energy?: string | null;
  source?: string | null;
  taggedAt?: string | null;
  bpm?: number | null;
  musicalKey?: string | null;
  loudnessLufs?: number | null;
  paceMean?: number | null;
  instrumental?: boolean | null;
}

export const router = express.Router();

// `cursor` is an opaque base64 of `albumOffset:songIndexInAlbum`; nextCursor is
// null only at the end of the walk. A page that spends its scan budget before
// filling `limit` still hands back a cursor (possibly with no rows), so a
// tagged stretch longer than the budget never reads as "nothing untagged".
// `scope=language` uses the same Navidrome walk but includes rows without a
// completed language result, even when their mood tags are already present.
// `scope=needs` is the combined Needs-tags view: a row is included when either
// its mood tags or its language result is missing.
router.get('/library/untagged', requireAdmin, async (req, res) => {
  await library.load();
  const scope = req.query?.scope === 'language' || req.query?.scope === 'needs'
    ? req.query.scope
    : 'mood';
  const limit = Math.min(Math.max(parseIntSafe(req.query?.limit, 50) ?? 50, 1), 100);
  const cursor = decodeCursor(typeof req.query?.cursor === 'string' ? req.query.cursor : '');
  const startAlbumOffset = cursor.albumOffset;
  const startSongIndex = cursor.songIndex;

  const rows: LibrarySong[] = [];
  let nextCursor: string | null = null;
  let visited = 0;
  // Avoid pathological full-library walks per request. Checked per album and
  // per song, so one request stops where the budget runs out.
  const SCAN_BUDGET = 5000;
  const BATCH = 200;
  let albumOffset = startAlbumOffset;
  let songIndex = startSongIndex;

  try {
    outer: for (;;) {
      const albums = await subsonic.getAlbumList(albumOffset, BATCH);
      if (albums.length === 0) break;
      for (let i = 0; i < albums.length; i++) {
        const first = i === 0 ? songIndex : 0;
        if (visited >= SCAN_BUDGET) {
          nextCursor = encodeCursor({ albumOffset: albumOffset + i, songIndex: first });
          break outer;
        }
        const album = albums[i];
        let songs: LibrarySong[] = [];
        try { songs = await subsonic.getAlbum(album.id); } catch { songs = []; }
        // A failed or empty album still cost a request.
        if (songs.length <= first) visited++;
        for (let j = first; j < songs.length; j++) {
          if (visited >= SCAN_BUDGET) {
            nextCursor = encodeCursor({ albumOffset: albumOffset + i, songIndex: j });
            break outer;
          }
          const s = songs[j];
          visited++;
          const stored = scope === 'mood' ? null : library.get(s.id);
          const moodTagged = scope === 'language' ? true : library.has(s.id);
          // An explicit unknown result is still unresolved from an operator's
          // perspective. Keep it in the language and combined Needs-tags
          // queues so the operator can review or set it manually. Instrumental
          // is a valid terminal result and remains complete.
          const languageTagged = !!stored?.language && stored.language.mode !== 'unknown';
          const needsTag = scope === 'mood'
            ? !moodTagged
            : scope === 'language'
              ? !languageTagged
              : !moodTagged || !languageTagged;
          if (!needsTag) continue;
          const era = stored ?? library.get(s.id);
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
            language: era?.language ?? null,
            languages: era?.language?.languages ?? [],
            duration: s.duration ?? null,
            moods: era?.moods ?? [],
            energy: era?.energy ?? null,
            source: era?.source ?? null,
            taggedAt: era?.taggedAt ?? null,
            bpm: era?.bpm ?? null,
            musicalKey: era?.musicalKey ?? null,
            loudnessLufs: era?.loudnessLufs ?? null,
            paceMean: era?.paceMean ?? null,
            instrumental: era ? isInstrumental(era.vocalRanges, era.vocalRangesInvalid) : null,
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

// The current run's log after sequence number `after`, so a page polling every
// few seconds misses nothing. `run` is the id the cursor belongs to: a cursor
// from an earlier run reads the new one from its start. `log: null` = no run
// since the controller started (earlier runs are in the files below).
router.get('/library/tagger/log', requireAdmin, (req, res) => {
  // RunLog.since() sanitises the cursor: NaN or a negative reads from the start.
  const run = typeof req.query.run === 'string' ? req.query.run : null;
  res.json({ log: taggerLogSince(Number(req.query.after), run) });
});

// The kept run logs, newest first (state/tagger-logs/, the last ten runs).
router.get('/library/tagger/logs', requireAdmin, (_req, res) => {
  res.json({ logs: taggerLogFiles() });
});

// One run log as a text download. The id is checked against the writer's own
// name pattern, so nothing outside those files can be read through it.
router.get('/library/tagger/logs/:id', requireAdmin, (req, res) => {
  const file = taggerLogFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'no such run log' });
  // A root keeps a hidden parent of the state dir (a clone under ~/.local, say)
  // out of sendFile's dotfile check, as util/audio-response.ts does. The headers
  // ride the file, so a file pruned since the check answers a plain 404.
  res.sendFile(path.basename(file), {
    root: path.dirname(file),
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${req.params.id}.log"`,
    },
  }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'no such run log' });
  });
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
    let lyricLanguage: string | null = null;
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
        const evidence = await subsonic.getLyricsEvidence(id);
        if (typeof evidence?.text === 'string' && evidence.text.trim()) lyricExcerpt = evidence.text.trim();
        lyricLanguage = evidence?.taggedLanguage || null;
      } catch (err) {
        queue.log('warn', `/library/retag enrich(lyrics) ${id}: ${err.message}`);
      }
    }
    if (lastfmEnabled || lyricsEnabled) {
      db.upsertTrackEnrichment(id, {
        lastfmTags: lastfmTags && lastfmTags.length ? lastfmTags : null,
        lyricExcerpt,
        lyricLanguage,
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
                vocalRangesInvalid: rec.vocalRangesInvalid,
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

// Operator-set language evidence. The input accepts a display name or an ISO
// code, but storage always uses a validated ISO 639-3 code. `null` clears only
// a manual override; automatic results are never destroyed by this endpoint.
router.post(
  '/library/manual-language',
  requireAdmin,
  validateBodyAsync(() => manualLanguageSchema, { messages: 'verbatim' }),
  async (req, res) => {
    const { id, language, applyToAlbum } = req.body as ManualLanguageBody;
    const code = language === null ? null : (canonicalLanguage(language) ?? null);
    if (language !== null && code === null) return res.status(400).json({ error: 'language must be a valid ISO 639 language name or code' });
    try {
      await library.load();
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
        if (code === null) {
          db.clearManualTrackLanguage(t.id);
        } else {
          const mode = code === 'zxx' ? 'instrumental' : code === 'und' || code === 'xxx' ? 'unknown' : 'single';
          db.upsertTrackLanguage(t.id, {
            primaryLanguage: mode === 'single' ? code : null,
            languages: mode === 'single' ? [code] : [],
            mode,
            source: 'manual',
            confidence: 'high',
            contractVersion: LANGUAGE_TAG_CONTRACT_VERSION,
            model: null,
          });
        }
      }
      const scope = applyToAlbum ? `album "${song.album}" (${targets.length} tracks)` : `"${song.title}"`;
      queue.log('info', code === null
        ? `manual-language: cleared override on ${scope}`
        : `manual-language: ${scope} → ${code}`);
      res.json({
        ok: true,
        updated: targets.length,
        cleared: code === null,
        language: code,
        tracks: targets.map(t => ({ id: t.id, language: code })),
      });
    } catch (err) {
      queue.log('error', `/library/manual-language failed: ${err.message}`);
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
