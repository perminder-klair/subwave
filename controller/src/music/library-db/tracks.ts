// Per-track reads and writes: metadata, tags, enrichment, analysis and vectors.
// The write path every ingest pass (tagger, analyzer, enricher) goes through.

import { ANALYSIS_VERSION, AUDIO_EMBEDDING_DIM, SQL_HAS_MOODS, SQL_TAIL_VOCAL_RANGES, TAGGER_VERSION, getEmbeddingDim, requireDb } from './handle.js';
import {
  FACETS, FACET_VERSIONS, SQL_WHOLE_FILE_LOUDNESS, WHOLE_FILE_LOUDNESS_EXTRAS, clearFacetFailures, clearFacetRows,
  isWholeFileLoudnessVersion, restampFacetRows, syncTrackFacets, tailPlacementMoved, type Facet, type FacetSource,
} from './facets.js';
import type { FileInfo, TagWrite, TrackEnrichment, TrackKeyRange, TrackMeta, TrackOutro, TrackPaceSpan, TrackRecord, TrackRow, TrackSection } from './types.js';
import { normaliseExplicitStatus, normaliseYear, rowToTrack, safeParseArray } from './rows.js';
import { SQL_KEPT_YEAR_SOURCES, type OriginalYearOutcome, type YearSource } from '../original-year-policy.js';
import { runDdl } from './schema.js';
import { touchGenreInputs } from './genre-inputs.js';
import { resolveEraYear } from '../era-year.js';
import { keepStoredTags } from '../lastfm-tag-policy.js';
import { MAX_ANALYSIS_FAILURES, analysisFailureExclusion } from '../analyze-capability.js';
import { acceptedAt, fileReplaced } from '../replaced-file-policy.js';
import { parseTailVocalRangesJson, parseVocalRangesJson } from '../lyric-vocal.js';
import { soundWords, type SoundPart, type SoundWords } from '../sound-line.js';
import { unavailableCurveJson, type WholeLoudnessCurve } from '../whole-loudness-curve.js';

export { MAX_ANALYSIS_FAILURES, analysisFailureExclusion } from '../analyze-capability.js';

export function getTrack(id: string): TrackRecord | null {
  const row = requireDb()
    .prepare(`SELECT * FROM tracks WHERE id = ?`)
    .get(id) as TrackRow | undefined;
  return row ? rowToTrack(row) : null;
}

// Whether a row exists for this id, without reading the row itself.
export function trackExists(id: string): boolean {
  return requireDb().prepare('SELECT 1 FROM tracks WHERE id = ?').get(id) !== undefined;
}

// Every track's name fields and length, for matching a stored snapshot back to
// its row after a file comes back under a new id (music/heart-follow.ts). A full
// scan, about a second on a 70k-track library: run it only when something is
// owed a match, never on a read path.
export function trackNameRows(): Array<{ id: string; title: string | null; artist: string | null; album: string | null; durationSec: number | null }> {
  return (requireDb()
    .prepare('SELECT id, title, artist, album, duration_sec FROM tracks')
    .all() as Array<{ id: string; title: string | null; artist: string | null; album: string | null; duration_sec: number | null }>)
    .map((r) => ({ id: r.id, title: r.title, artist: r.artist, album: r.album, durationSec: r.duration_sec }));
}

export function getTaggedAt(id: string): string | null {
  const row = requireDb()
    .prepare<[string], Pick<TrackRow, 'tagged_at'>>('SELECT tagged_at FROM tracks WHERE id = ?')
    .get(id);
  return row?.tagged_at ?? null;
}

export interface TrackLite {
  genres: string[];
  genre: string | null;
  bpm: number | null;
  musicalKey: string | null;
  moods: string[];
  energy: string | null;
  year: number | null;
  // Era resolution reads the composed `yearUntrusted` (#842, #1418);
  // `isCompilation` is the raw Navidrome fact beside it.
  originalYear: number | null;
  isCompilation: boolean | null;
  yearUntrusted: boolean | null;
  durationSec: number | null;
  // Edge dead air (music/silence-trim.ts).
  leadSilenceMs: number | null;
  tailSilenceMs: number | null;
  tailStartMs: number | null;
}

// Lean read for the /now-playing hot path (polled every ~5s per listener).
// Scalar columns only: a full getTrack() JSON.parses the fat acoustic *_json
// blobs on better-sqlite3's single synchronous thread (#723).
export function getTrackLite(id: string): TrackLite | null {
  const row = requireDb()
    .prepare(`SELECT genres, genre, bpm, musical_key, moods, energy, year, original_year, is_compilation, era_untrusted, duration_sec, lead_silence_ms, tail_silence_ms, tail_start_ms FROM tracks WHERE id = ?`)
    .get(id) as Pick<TrackRow, 'genres' | 'genre' | 'bpm' | 'musical_key' | 'moods' | 'energy' | 'year' | 'original_year' | 'is_compilation' | 'era_untrusted' | 'duration_sec' | 'lead_silence_ms' | 'tail_silence_ms' | 'tail_start_ms'> | undefined;
  if (!row) return null;
  return {
    genres: row.genres ? safeParseArray(row.genres) : [],
    genre: row.genre ?? null,
    bpm: row.bpm ?? null,
    musicalKey: row.musical_key ?? null,
    moods: row.moods ? safeParseArray(row.moods) : [],
    energy: row.energy ?? null,
    year: row.year ?? null,
    originalYear: row.original_year ?? null,
    isCompilation: row.is_compilation == null ? null : !!row.is_compilation,
    // Same composition as rowToTrack; era consumers read this, not the raw flag.
    yearUntrusted: (row.is_compilation === 1 || row.era_untrusted === 1)
      ? true
      : (row.is_compilation == null && row.era_untrusted == null ? null : false),
    durationSec: row.duration_sec ?? null,
    // Edge dead air: an auto-playlist play has no queue item carrying the
    // stamped cue points, so /now-playing resolves the trim from the row.
    leadSilenceMs: row.lead_silence_ms ?? null,
    tailSilenceMs: row.tail_silence_ms ?? null,
    tailStartMs: row.tail_start_ms ?? null,
  };
}

// The two era/compilation columns only. A third lean read rather than
// getTrackLite: the album cooldown (#1485 FR 3) resolves this per candidate and
// per play in its window, and getTrackLite would JSON.parse genres and moods for
// each. null = no such row (a Subsonic-only track), meaning "no evidence",
// never "not a compilation".
export function getAlbumFacts(id: string): { isCompilation: boolean | null; yearUntrusted: boolean | null } | null {
  const row = requireDb()
    .prepare(`SELECT is_compilation, era_untrusted FROM tracks WHERE id = ?`)
    .get(id) as Pick<TrackRow, 'is_compilation' | 'era_untrusted'> | undefined;
  if (!row) return null;
  return {
    isCompilation: row.is_compilation == null ? null : !!row.is_compilation,
    // Same composition as rowToTrack/getTrackLite: OR, not COALESCE.
    yearUntrusted: (row.is_compilation === 1 || row.era_untrusted === 1)
      ? true
      : (row.is_compilation == null && row.era_untrusted == null ? null : false),
  };
}

// Coverage meter's "tagged" tally. Keep this aligned with allTaggedIds() and
// the rest of the tagged-library reads: empty mood arrays are uncertainty
// results, not completed tags.
export function countTagged(): number {
  return (
    requireDb().prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${SQL_HAS_MOODS}`).get() as {
      n: number;
    }
  ).n;
}

export function hasTags(id: string): boolean {
  const row = requireDb()
    .prepare(`SELECT 1 FROM tracks WHERE id = ? AND ${SQL_HAS_MOODS}`)
    .get(id);
  return !!row;
}

export function hasVector(id: string): boolean {
  const row = requireDb().prepare(`SELECT 1 FROM track_vectors WHERE id = ?`).get(id);
  return !!row;
}

interface StoredEra {
  year: number | null;
  original_year: number | null;
  is_compilation: number | null;
  era_untrusted: number | null;
}

function storedEra(id: string): StoredEra | null {
  return (requireDb()
    .prepare(`SELECT year, original_year, is_compilation, era_untrusted FROM tracks WHERE id = ?`)
    .get(id) as StoredEra | undefined) ?? null;
}

function resolvedStoredEra(row: StoredEra): number | null {
  const untrusted = row.is_compilation === 1 || row.era_untrusted === 1;
  return resolveEraYear(row.year, row.original_year, untrusted);
}

export function resolvedEraYearForTrack(id: string): number | null {
  const row = storedEra(id);
  return row ? resolvedStoredEra(row) : null;
}

// The year facet row reads the era columns, so a write that changes them (or
// creates the track) re-derives it. A walk that changes nothing era-related
// costs no facet work.
function syncYearIfEraChanged(id: string, before: StoredEra | null): void {
  const after = storedEra(id);
  if (!after) return;
  const suspect = (r: StoredEra) => r.is_compilation === 1 || r.era_untrusted === 1;
  if (before && suspect(before) === suspect(after) && before.original_year === after.original_year) return;
  syncTrackFacets(id);
}

function markTextVectorDirty(id: string): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET text_vector_dirty = 1
        WHERE id = ? AND EXISTS (SELECT 1 FROM track_vectors WHERE id = tracks.id)`,
    )
    .run(id);
}

function markTextVectorDirtyIfEraChanged(id: string, before: StoredEra | null): void {
  if (!before) return;
  const after = storedEra(id);
  if (!after || resolvedStoredEra(before) === resolvedStoredEra(after)) return;
  markTextVectorDirty(id);
}

// text_vector_sound, the Sound: words the vector was built from (migration 36),
// by part. A null part is one a relabel-all forgot (forgetVectorSoundIfMoved).
// Anything unreadable is unknown, like NULL.
type BuiltSound = { [P in SoundPart]: string[] | null };
function parseVectorSound(json: string | null): BuiltSound | null {
  if (json == null) return null;
  try {
    const v = JSON.parse(json);
    const part = (x: unknown) => (Array.isArray(x) ? x.map(String) : x === null ? null : undefined);
    const moods = part(v?.moods);
    const measured = part(v?.measured);
    if (moods !== undefined && measured !== undefined) return { moods, measured };
  } catch { /* unknown */ }
  return null;
}

const sameWords = (a: string[], b: string[]) => a.length === b.length && a.every((w, i) => w === b[i]);

// The row's Sound: words now, beside the words its vector was built from. Null
// when the row is gone or the vector's words are unknown. The row is read as
// getTrack() would see it, with the tail through SQL_TAIL_VOCAL_RANGES, never
// outro_json.
function soundAgainstVector(id: string): { now: SoundWords; built: BuiltSound } | null {
  const row = requireDb()
    .prepare(
      `SELECT bpm, musical_key, audio_moods, vocal_ranges_json,
              ${SQL_TAIL_VOCAL_RANGES} AS tail_vocal_ranges_json, text_vector_sound
         FROM tracks WHERE id = ?`,
    )
    .get(id) as (Pick<TrackRow, 'bpm' | 'musical_key' | 'audio_moods' | 'vocal_ranges_json' | 'text_vector_sound'> & {
      tail_vocal_ranges_json: string | null;
    }) | undefined;
  const built = parseVectorSound(row?.text_vector_sound ?? null);
  if (!row || !built) return null;
  const now = soundWords({
    bpm: row.bpm, musicalKey: row.musical_key,
    audioMoods: row.audio_moods ? safeParseArray(row.audio_moods) : [],
    ...parseVocalRangesJson(row.vocal_ranges_json),
    ...parseTailVocalRangesJson(row.tail_vocal_ranges_json),
  });
  return { now, built };
}

// A measurement that lands after its vector (#2236): a new track is embedded in
// phase 1 and analysed in phase 5, so its first vector has no Sound: line. The
// one rule: a write marks the vector when the words of a part it writes now
// differ from the words the vector was built from. Against the vector, never the
// row before the write: a re-analyze clears the row first, so a before/after
// compare would call every row changed. By part, because the parts land at
// different times (sound-line.ts). Unknown (NULL, or a part a relabel-all forgot)
// never marks, so a vector from before the upgrade stays on manual Re-embed.
// One-way, like the era mark: equal words never clear a flag another writer set.
export function markTextVectorDirtyIfSoundChanged(id: string, parts: readonly SoundPart[]): void {
  const s = soundAgainstVector(id);
  if (!s) return;
  if (parts.every(p => s.built[p] == null || sameWords(s.now[p], s.built[p]))) return;
  markTextVectorDirty(id);
}

// A relabel-all (a vocabulary or calibration change, or crossing the floor) moves
// a part's words on every row at once and marks nothing, or it would re-embed the
// whole library. The vectors still hold the old words, though, and an identical
// --re-analyze relabels every row again through the incremental branch, which
// would find each one changed and mark it: the same whole library, one re-analyze
// later. So the relabel forgets the part where it moved the vector's words, and
// that part stays unknown until the vector is rebuilt.
export function forgetVectorSoundIfMoved(id: string, part: SoundPart): void {
  const s = soundAgainstVector(id);
  if (!s || s.built[part] == null || sameWords(s.now[part], s.built[part])) return;
  requireDb()
    .prepare(`UPDATE tracks SET text_vector_sound = ? WHERE id = ?`)
    .run(JSON.stringify({ ...s.built, [part]: null }), id);
}

// Existing vectors whose source text changed: an era edit, (opt-in) the track's
// Last.fm tags, a measurement that moved its Sound: words, or migration 32's tail
// verdict. They remain in the KNN index until phaseEmbed successfully replaces them.
export function textVectorDirtyIds(): string[] {
  return (requireDb()
    .prepare(
      `SELECT t.id FROM tracks t
        JOIN track_vectors v ON v.id = t.id
        WHERE t.text_vector_dirty = 1`,
    )
    .all() as Array<{ id: string }>).map(r => r.id);
}

// Rounds before it checks, so the test is on the value that gets stored: a stored
// 0 is not NULL, and it would overwrite a good value through the COALESCE.
function positiveInt(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The one cleaning rule for a track's file facts. Anything it nulls counts as not
// reported, so COALESCE keeps what is stored. Running it twice changes nothing.
export function cleanFileInfo(raw: { [K in keyof FileInfo]?: unknown }): FileInfo {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  return {
    filePath: text(raw.filePath),
    fileSuffix: text(raw.fileSuffix)?.toLowerCase() ?? null,
    fileSize: positiveInt(raw.fileSize),
    bitRate: positiveInt(raw.bitRate),
  };
}

// When the whole track was last measured: its OLDEST analysis facet row, the
// time every answer has stood since. NULL = never measured. Not the newest
// row: a write of one facet (the CLAP-only fast path, a facet plan) re-measures
// that facet alone, and would pass the rest off as measured after a replacement.
// Caveat: the seed dates every row of a track from when the facet table was
// created, so a file replaced before that reads as measured after its change
// and is left to the size signal. The year row is not a measurement.
export function lastMeasuredAt(id: string): string | null {
  const r = requireDb()
    .prepare(`SELECT MIN(at) AS at FROM track_facet_status WHERE track_id = ? AND facet <> 'year'`)
    .get(id) as { at: string | null } | undefined;
  return r?.at ?? null;
}

// The oldest measurement in the library: a file Navidrome last changed before
// it cannot be stale for any track (file-changes.changedFiles' first floor).
export function earliestMeasuredAt(): string | null {
  const r = requireDb()
    .prepare(`SELECT MIN(at) AS at FROM track_facet_status WHERE facet <> 'year'`)
    .get() as { at: string | null } | undefined;
  return r?.at ?? null;
}

// Everything the analyzer measured from a track's audio, for one track: the
// head analysis and its loudness, the whole-file loudness (its curve too) and
// edges, the tail, vocal ranges, the stems stamp, CLAP and the audio moods and
// descriptors derived from it, the map position derived from CLAP, and the
// failure history that described the old file. Unlike clearAnalysis() nothing
// is kept: every figure was measured on a file that is gone, and a whole-file
// column left set would have syncTrackFacets() mark its facet measured again. Metadata,
// tags, years, lyrics and plays are not audio measurements and stay. The stem
// files themselves are the caller's (stem-cache.forgetStems), since this runs
// inside the walk's sync write. `fileSize`, from the walk's size signal, is
// stored here with the clear: upsertTrackMeta keeps the old size until then, so
// a held clear is found again by the next walk.
// An analysis pass runs in its own process: one that read the old file before
// the walk cleared it can still write that measurement afterwards, and then the
// replacement is not revisited (a narrow window; a later edit re-triggers it).
export function clearTrackAudio(id: string, fileSize?: number | null): void {
  const d = requireDb();
  d.transaction(() => {
    const size = positiveInt(fileSize);
    if (size != null) d.prepare('UPDATE tracks SET file_size = ? WHERE id = ?').run(size, id);
    d.prepare(
      `UPDATE tracks SET bpm = NULL, musical_key = NULL, intro_ms = NULL, analysis_confidence = NULL,
         analysis_version = NULL, loudness_lufs = NULL, peak_db = NULL, ${CLEAR_WHOLE_FILE_EXTRAS},
         structure_json = NULL, vocal_ranges_json = NULL, pace_json = NULL, beats_json = NULL,
         bars_json = NULL, key_ranges_json = NULL, audio_moods = NULL, audio_mood_scores_json = NULL,
         audio_descriptors = NULL, audio_descriptor_scores_json = NULL,
         outro_json = NULL, tail_silence_ms = NULL, tail_start_ms = NULL, tail_version = NULL, lead_silence_ms = NULL,
         edge_lead_ms = NULL, edge_tail_ms = NULL, decoded_duration_ms = NULL,
         stems_at = NULL, map_x = NULL, map_y = NULL,
         analyze_error = NULL, analyze_failed_at = NULL, analyze_fail_count = NULL
       WHERE id = ?`,
    ).run(id);
    d.prepare('DELETE FROM track_audio_vectors WHERE id = ?').run(id);
    // The analysis rows (and the unmeasurable answers they carry) described the
    // old file; the year row is not an audio measurement (a failed lookup's
    // attempt count lives only there).
    d.prepare(`DELETE FROM track_facet_status WHERE track_id = ? AND facet <> 'year'`).run(id);
    syncTrackFacets(id);
  })();
}

// The operator's other answer to a replaced file: the audio did not change (a
// tag editor's "save all", a restore that reset file dates), so nothing is
// cleared and every measurement stands for the file as it is now. `files` is
// the walk's candidates: id -> the walked size, or null from the change-time
// signal. `changedAt` is what Navidrome dated each, where it said (acceptedAt).
// One transaction, so a walk that dies here asks again in full.
export function acceptReplacedFiles(
  files: ReadonlyMap<string, number | null>,
  changedAt: ReadonlyMap<string, string> = new Map(),
): void {
  const d = requireDb();
  const setSize = d.prepare('UPDATE tracks SET file_size = ? WHERE id = ?');
  d.transaction(() => {
    for (const [id, fileSize] of files) {
      const size = positiveInt(fileSize);
      if (size != null) setSize.run(size, id);
      restampFacetRows(id, acceptedAt(changedAt.get(id)));
    }
  })();
}

// Returns true when the walk found the file replaced (replaced-file-policy
// fileReplaced: its size changed). Nothing is cleared here: the walk gathers
// every candidate and clears them at its end, behind a mass hold
// (replaced-file-policy.decideReplacedClear), with clearTrackAudio(id, size).
// Until then the stored size is kept, so a held candidate is found again.
export function upsertTrackMeta(id: string, meta: TrackMeta): boolean {
  const eraBefore = storedEra(id);
  const file = cleanFileInfo(meta);
  const walkedSize = file.fileSize;
  const storedSize = walkedSize == null ? null
    : (requireDb().prepare('SELECT file_size AS s FROM tracks WHERE id = ?').get(id) as { s: number | null } | undefined)?.s ?? null;
  const replaced = fileReplaced(storedSize, walkedSize);
  requireDb()
    .prepare(
      `
      INSERT INTO tracks (id, title, artist, album, album_id, artist_id, year, original_year, original_year_source, is_compilation, era_untrusted, genres, duration_sec,
                          file_path, file_suffix, file_size, bit_rate, explicit_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title        = COALESCE(excluded.title, tracks.title),
        artist       = COALESCE(excluded.artist, tracks.artist),
        album        = COALESCE(excluded.album, tracks.album),
        -- COALESCE: the walk is the only writer that HAS these ids, so a manual
        -- edit or analyzer top-up passing undefined must not blank a walked row.
        album_id     = COALESCE(excluded.album_id, tracks.album_id),
        artist_id    = COALESCE(excluded.artist_id, tracks.artist_id),
        year         = COALESCE(excluded.year, tracks.year),
        -- Walk-time 'album-tag' years never clobber a looked-up or typed one
        -- (original-year-policy.KEPT_YEAR_SOURCES: musicbrainz, discogs, manual).
        -- When an album turns era-suspect, discard an earlier album-tag answer:
        -- left in place it looks resolved and blocks the MB backfill.
        original_year = CASE
          WHEN tracks.original_year_source IN ${SQL_KEPT_YEAR_SOURCES}
            THEN tracks.original_year
          WHEN excluded.era_untrusted = 1
            AND excluded.original_year IS NULL
            AND tracks.original_year_source = 'album-tag'
            THEN NULL
          ELSE COALESCE(excluded.original_year, tracks.original_year)
        END,
        original_year_source = CASE
          WHEN tracks.original_year_source IN ${SQL_KEPT_YEAR_SOURCES}
            THEN tracks.original_year_source
          WHEN excluded.era_untrusted = 1
            AND excluded.original_year IS NULL
            AND tracks.original_year_source = 'album-tag'
            THEN NULL
          ELSE COALESCE(excluded.original_year_source, tracks.original_year_source)
        END,
        is_compilation = COALESCE(excluded.is_compilation, tracks.is_compilation),
        era_untrusted  = COALESCE(excluded.era_untrusted, tracks.era_untrusted),
        genres       = COALESCE(excluded.genres, tracks.genres),
        duration_sec = COALESCE(excluded.duration_sec, tracks.duration_sec),
        -- File facts: only the library walks pass them; any other writer passes NULL.
        file_path    = COALESCE(excluded.file_path, tracks.file_path),
        file_suffix  = COALESCE(excluded.file_suffix, tracks.file_suffix),
        file_size    = COALESCE(excluded.file_size, tracks.file_size),
        bit_rate     = COALESCE(excluded.bit_rate, tracks.bit_rate),
        -- A CASE, not COALESCE: the walk must be able to clear a removed tag,
        -- and every other writer (undefined) must leave the walked value alone.
        explicit_status = CASE WHEN ? = 1 THEN excluded.explicit_status ELSE tracks.explicit_status END
    `,
    )
    .run(
      id,
      meta.title ?? null,
      meta.artist ?? null,
      meta.album ?? null,
      meta.albumId ?? null,
      meta.artistId ?? null,
      normaliseYear(meta.year),
      normaliseYear(meta.originalYear),
      normaliseYear(meta.originalYear) != null ? 'album-tag' : null,
      meta.isCompilation == null ? null : meta.isCompilation ? 1 : 0,
      meta.eraUntrusted == null ? null : meta.eraUntrusted ? 1 : 0,
      meta.genres?.length ? JSON.stringify(meta.genres) : null,
      Number.isFinite(meta.duration as number) ? (meta.duration as number) : null,
      file.filePath,
      file.fileSuffix,
      replaced ? storedSize : walkedSize,
      file.bitRate,
      normaliseExplicitStatus(meta.explicitStatus),
      meta.explicitStatus === undefined ? 0 : 1,
    );
  markTextVectorDirtyIfEraChanged(id, eraBefore);
  syncYearIfEraChanged(id, eraBefore);
  return replaced;
}

// Era-suspect tracks with no year (#842): never checked, or also already-checked
// misses with `retryMisses`. The automatic passes plan from the year facet
// instead (facets.yearLookupDueIds, which also keeps a failed lookup off until
// its retry delay); this is the `--re-enrich` miss scope, intersected with the
// run's own tracks by the caller.
export function idsNeedingOriginalYear(retryMisses = false): string[] {
  const extra = retryMisses ? '' : 'AND original_year_checked_at IS NULL';
  return (
    requireDb()
      .prepare(
        // Era-suspect, not just flagged. SQL twin of
        // musicbrainz.needsOriginalYearLookup; the two must stay in agreement.
        `SELECT id FROM tracks
          WHERE (is_compilation = 1 OR era_untrusted = 1)
            AND original_year IS NULL ${extra}`,
      )
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

// Record a per-track original-year lookup. `checked_at` is stamped on hit AND
// miss, so a resumed pass skips what it already asked MusicBrainz about.
export function setOriginalYear(id: string, year: number | null, source: YearSource = 'musicbrainz'): void {
  const eraBefore = storedEra(id);
  requireDb()
    .prepare(
      `UPDATE tracks SET
         original_year            = COALESCE(?, original_year),
         original_year_source     = CASE WHEN ? IS NOT NULL THEN ? ELSE original_year_source END,
         original_year_checked_at = ?
       -- Never touch a manual override, not even its checked_at stamp; the
       -- guard sits at the write so a new caller can't route around it.
       WHERE id = ? AND (original_year_source IS NULL OR original_year_source <> 'manual')`,
    )
    .run(year, year, source, new Date().toISOString(), id);
  markTextVectorDirtyIfEraChanged(id, eraBefore);
  syncTrackFacets(id, { fresh: ['year'], source });
}

// The one writer of a year lookup's outcome (original-year-policy.ts). A found /
// not-found answer is stamped on the track. An error adds a failed attempt to
// the year facet row, which spaces the next automatic retry; when it was a
// not-found being asked again, that old answer is withdrawn too (its stamp
// cleared), so the track is retried on the schedule instead of falling back
// into a "not found" the failed question never confirmed. A resolved or manual
// year is never touched (a manual override always carries its year).
export function recordOriginalYearOutcome(id: string, outcome: OriginalYearOutcome): void {
  requireDb().transaction(() => {
    if (outcome.kind === 'error') {
      requireDb()
        .prepare(
          `UPDATE tracks SET original_year_checked_at = NULL
            WHERE id = ? AND original_year IS NULL`,
        )
        .run(id);
      const source = outcome.source ?? 'musicbrainz';
      syncTrackFacets(id, { yearFailed: outcome.reason, source });
      // The failed row names the host that failed this time; a re-derive keeps
      // a row's earlier source, so it is set here rather than through the sync.
      requireDb()
        .prepare(`UPDATE track_facet_status SET source = ? WHERE track_id = ? AND facet = 'year' AND status = 'failed'`)
        .run(source, id);
      return;
    }
    setOriginalYear(id, outcome.kind === 'found' ? outcome.year : null, outcome.source ?? 'musicbrainz');
  })();
}

// The operator's own original year (#1418), highest-precedence of the three
// sources. `year: null` REMOVES the override rather than pinning "unknown": the
// track re-enters the automatic pipeline. The old embedding stays in the KNN
// index marked dirty, so the next tag pass replaces its stale `Era:` line.
export function setManualOriginalYear(id: string, year: number | null): void {
  const eraBefore = storedEra(id);
  if (year != null) {
    requireDb()
      .prepare(
        `UPDATE tracks SET
           original_year            = ?,
           original_year_source     = 'manual',
           original_year_checked_at = ?
         WHERE id = ?`,
      )
      .run(year, new Date().toISOString(), id);
  } else {
    // Clearing removes an OVERRIDE only; a non-manual row is a no-op. The
    // route's applyToAlbum loop runs this over every album track, and a
    // sibling's 'musicbrainz'/'album-tag' year is a resolution, not an override.
    requireDb()
      .prepare(
        `UPDATE tracks SET
           original_year            = NULL,
           original_year_source     = NULL,
           original_year_checked_at = NULL
         WHERE id = ? AND original_year_source = 'manual'`,
      )
      .run(id);
  }
  markTextVectorDirtyIfEraChanged(id, eraBefore);
  syncTrackFacets(id);
}

// The stamp describes the stored list, so a write that replaces the list clears
// it and the row is owed a lookup again: with the opt-in off, a re-enrich puts
// the artist-only list back, and turning it on later has to see that. A station
// that never turned it on has no stamps, so this changes nothing there.
export function upsertTrackEnrichment(id: string, enrich: TrackEnrichment): void {
  const lastfmTags = enrich.lastfmTags ? JSON.stringify(enrich.lastfmTags) : null;
  requireDb()
    .prepare(
      `UPDATE tracks SET
         lastfm_track_tags_at = CASE WHEN lastfm_tags IS ? THEN lastfm_track_tags_at END,
         lastfm_tags = ?, lyric_excerpt = ?, enriched_at = ?
       WHERE id = ?`,
    )
    .run(
      lastfmTags,
      lastfmTags,
      enrich.lyricExcerpt ?? null,
      new Date().toISOString(),
      id,
    );
}

// Tracks still owed a track.getTopTags lookup. Not scoped to the tagger's
// untagged/enriched sets, for the same reason as idsNeedingOriginalYear. A row
// with no artist or title can't be asked about, so it is never owed.
export function idsNeedingLastfmTrackTags(): string[] {
  return (
    requireDb()
      .prepare(
        `SELECT id FROM tracks
          WHERE lastfm_track_tags_at IS NULL
            AND TRIM(COALESCE(artist, '')) <> ''
            AND TRIM(COALESCE(title, '')) <> ''`,
      )
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

// The one write of a track-aware Last.fm list, shared by the bulk pass and the
// retag route. A genuine answer stamps the row, hit or miss, and replaces the
// list if it has tags on it: one with none says nothing about a list that may
// have come from Navidrome. A row's first answer also keeps what the row already
// held (keepStoredTags): only a row that has been answered holds its own old
// tags, which are the ones to let go of. Anything else stamps nothing and never
// costs a row the list it has, so an outage leaves the library as it found it; a
// row with no list takes what did come back, so a new track isn't embedded bare.
// Only a real
// change touches the list or dirties the vector: `lastfm_tags` is in the search
// keys' trigger, and the embed text is built from this exact order. Returns the
// stored list.
export function recordLastfmTrackTags(
  id: string,
  lookup: { tags: string[]; answered: boolean },
): string[] | null {
  const d = requireDb();
  const row = d.prepare(`SELECT lastfm_tags, lastfm_track_tags_at FROM tracks WHERE id = ?`).get(id) as
    | Pick<TrackRow, 'lastfm_tags' | 'lastfm_track_tags_at'>
    | undefined;
  if (!row) return null;
  const stored = row.lastfm_tags ? safeParseArray(row.lastfm_tags) : [];
  const replaces = lookup.answered && lookup.tags.length > 0;
  const next = replaces && !row.lastfm_track_tags_at
    ? keepStoredTags(lookup.tags, stored)
    : replaces || stored.length === 0 ? lookup.tags : stored;
  if (JSON.stringify(next) !== JSON.stringify(stored)) {
    d.prepare(`UPDATE tracks SET lastfm_tags = ? WHERE id = ?`)
      .run(next.length ? JSON.stringify(next) : null, id);
    markTextVectorDirty(id);
  }
  if (lookup.answered) {
    d.prepare(`UPDATE tracks SET lastfm_track_tags_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }
  return next.length ? next : null;
}

export function upsertTrackTags(id: string, tags: TagWrite): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET
        moods          = ?,
        energy         = ?,
        source         = ?,
        confidence     = ?,
        tagger_version = ?,
        prompt_hash    = ?,
        model          = ?,
        tagged_at      = ?,
        untaggable_key = NULL,
        tagged_measured = ?
      WHERE id = ?`,
    )
    .run(
      JSON.stringify(tags.moods),
      tags.energy,
      tags.source,
      tags.confidence ?? null,
      TAGGER_VERSION,
      tags.promptHash ?? null,
      tags.model ?? null,
      new Date().toISOString(),
      tags.taggedMeasured == null ? null : Number(tags.taggedMeasured),
      id,
    );
}

// Back to the untagged pool. NULL every tag column rather than writing
// moods='[]', so source/tagged_at don't go stale on an untagged row. The
// untaggable marker goes too: an operator's clear asks for a fresh answer.
export function clearTrackTags(id: string): void {
  markTrackUntaggable(id, null);
}

// The LLM had no mood for this track (#2283). The row stays untagged, like
// clearTrackTags, and `key` records what was asked (music/tag-library/tag-input.ts)
// so the next run does not ask the same thing again. null clears it.
export function markTrackUntaggable(id: string, key: string | null): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET
        moods          = NULL,
        energy         = NULL,
        source         = NULL,
        confidence     = NULL,
        tagger_version = NULL,
        prompt_hash    = NULL,
        model          = NULL,
        tagged_at      = NULL,
        untaggable_key = ?,
        tagged_measured = NULL
      WHERE id = ?`,
    )
    .run(key, id);
}

interface TrackAnalysisWrite {
  bpm?: number | null;
  musicalKey?: string | null;
  introMs?: number | null;
  confidence?: number | null;
  loudnessLufs?: number | null;
  peakDb?: number | null;
  sections?: TrackSection[] | null;
  // [] means measured with no vocal spans; isInstrumental owns classification.
  // null/undefined means not computed. Only a non-null array is written,
  // so a vocal-off pass leaves the column be.
  vocalRanges?: TrackSection[] | null;
  pace?: TrackPaceSpan[] | null;
  beats?: number[] | null;
  bars?: number[] | null;
  keyRanges?: TrackKeyRange[] | null;
  // null keeps the existing value (COALESCE): a pass that couldn't reach the
  // tail must not wipe a complete pass's measurement.
  outro?: TrackOutro | null;
  // A targeted run that disables vocals must keep the outro's separate vocal
  // measurement, just as COALESCE keeps the head vocal ranges.
  preserveTailVocal?: boolean;
  // Edge dead air (ms). The head is measurable on every pass and overwrites;
  // the tail follows the outro's COALESCE rule.
  leadSilenceMs?: number | null;
  tailSilenceMs?: number | null;
  tailStartMs?: number | null;
  // 2 = the analyzer placed the tail window from the stored edges; it then
  // replaces whatever tail is stored. Absent = the end-of-file window, which
  // never replaces a placed tail.
  tailVersion?: number | null;
  // true stamps stems_at so the backfill scope drops the track. Pass true for a
  // MISS too: the stamp records the attempt, not disk presence (migration 17).
  stemsAttempted?: boolean;
  // Where the audio came from — recorded on the facet rows this write
  // measures, and how an unmeasured tail is explained. Omitted = 'unknown'.
  source?: FacetSource;
}

// Tail vocal ranges describe one window. THE same-window rule, for every path
// that carries them onto a new outro or merges them into the stored one: the
// stored tail and the new evidence must both be placed from the edges
// (tail_version >= 2) or both be the end-of-file window.
function storedTailPlaced(id: string): boolean {
  const row = requireDb().prepare('SELECT tail_version AS v FROM tracks WHERE id = ?').get(id) as
    { v: number | null } | undefined;
  return (row?.v ?? 1) >= 2;
}
export function sameTailWindow(storedPlaced: boolean, newPlaced: boolean): boolean {
  return storedPlaced === newPlaced;
}

// A new outro without tail vocals keeps the stored ones, only when they were
// measured on the same window (sameTailWindow). A tail newly placed from the
// edges leaves them to be measured again (the vocal facet turns head-only, so
// the vocal backfill takes it).
function preserveTailVocal(id: string, outro: TrackOutro, newPlaced: boolean): TrackOutro {
  if (outro.vocalRanges != null) return outro;
  if (!sameTailWindow(storedTailPlaced(id), newPlaced)) return outro;
  const prior = getTrack(id)?.outro?.vocalRanges;
  return prior != null ? { ...outro, vocalRanges: prior } : outro;
}

// Stamps ANALYSIS_VERSION so resumable runs skip analysed rows and a bump
// re-targets stale ones. UPDATE on an existing meta row.
export function upsertTrackAnalysis(id: string, a: TrackAnalysisWrite): void {
  const d = requireDb();
  d.transaction(() => {
  const wholeFileLoudness = hasWholeFileLoudness(id);
  // `placedAnswer`: the analyzer used the placement, so even a tail it could
  // not measure is a settled answer (tailUnplaced below). `placed`: the v2
  // stamp, only with a tail measured on that window. Stamped over the stored
  // columns that a null outro keeps (COALESCE below), it would call an
  // end-of-file tail placed, and it would never be planned again.
  const placedAnswer = finite(a.tailVersion) != null && (a.tailVersion as number) >= 2;
  const tailMeasured = a.outro != null || finite(a.tailSilenceMs) != null;
  const placed = placedAnswer && tailMeasured ? 1 : 0;
  let outro = a.outro;
  let carriedTailVocal = false;
  if (a.preserveTailVocal && outro) {
    const kept = preserveTailVocal(id, outro, placed === 1);
    carriedTailVocal = kept !== outro;
    outro = kept;
  }
  d
    .prepare(
      `UPDATE tracks SET
        bpm                 = ?,
        musical_key         = ?,
        intro_ms            = ?,
        analysis_confidence = ?,
        -- A whole-file loudness figure outranks the analysis window's: a head
        -- analysis never overwrites it, and a window figure written in its
        -- place carries none of its extras.
        loudness_lufs       = CASE WHEN ${SQL_WHOLE_FILE_LOUDNESS} THEN loudness_lufs ELSE ? END,
        peak_db             = CASE WHEN ${SQL_WHOLE_FILE_LOUDNESS} THEN peak_db ELSE ? END,
        ${KEEP_WHOLE_FILE_EXTRAS},
        structure_json      = ?,
        pace_json           = ?,
        beats_json          = ?,
        bars_json           = ?,
        key_ranges_json     = ?,
        lead_silence_ms     = ?,
        -- COALESCE: vocal activity is gated separately (ANALYZE_VOCAL_ACTIVITY),
        -- so a plain bpm/key pass passes null and must not wipe this.
        vocal_ranges_json   = COALESCE(?, vocal_ranges_json),
        -- Outro: only computable off a COMPLETE file, so a capped-download pass
        -- passes null and keeps what's there. The two tail columns ride the
        -- outro decode and share the rule. A tail placed from the edges
        -- (tail_version >= 2) outranks an end-of-file window: kept, unless
        -- this answer was placed too (then it replaces it).
        outro_json          = CASE WHEN COALESCE(tail_version, 1) >= 2 AND ? = 0 THEN outro_json ELSE COALESCE(?, outro_json) END,
        tail_silence_ms     = CASE WHEN COALESCE(tail_version, 1) >= 2 AND ? = 0 THEN tail_silence_ms ELSE COALESCE(?, tail_silence_ms) END,
        tail_start_ms       = CASE WHEN COALESCE(tail_version, 1) >= 2 AND ? = 0 THEN tail_start_ms ELSE COALESCE(?, tail_start_ms) END,
        -- An end-of-file outro written over a tail marked for re-planning (1)
        -- is the end-of-file window again: back to NULL.
        tail_version        = CASE WHEN ? = 1 THEN 2
                                   WHEN COALESCE(tail_version, 1) < 2 AND ? IS NOT NULL THEN NULL
                                   ELSE tail_version END,
        -- A pass with the stem cache off passes null and must not clear an
        -- earlier stem pass's stamp.
        stems_at            = COALESCE(?, stems_at),
        -- Success wipes the failure history: analyze_fail_count counts
        -- CONSECUTIVE failures.
        analyze_error       = NULL,
        analyze_failed_at   = NULL,
        analyze_fail_count  = NULL,
        analysis_version    = ?
      WHERE id = ?`,
    )
    .run(
      Number.isFinite(a.bpm as number) ? (a.bpm as number) : null,
      a.musicalKey ?? null,
      Number.isFinite(a.introMs as number) ? Math.round(a.introMs as number) : null,
      Number.isFinite(a.confidence as number) ? (a.confidence as number) : null,
      Number.isFinite(a.loudnessLufs as number) ? (a.loudnessLufs as number) : null,
      Number.isFinite(a.peakDb as number) ? (a.peakDb as number) : null,
      a.sections && a.sections.length ? JSON.stringify(a.sections) : null,
      a.pace && a.pace.length ? JSON.stringify(a.pace) : null,
      a.beats && a.beats.length ? JSON.stringify(a.beats) : null,
      a.bars && a.bars.length ? JSON.stringify(a.bars) : null,
      a.keyRanges && a.keyRanges.length ? JSON.stringify(a.keyRanges) : null,
      Number.isFinite(a.leadSilenceMs as number) ? Math.max(0, Math.round(a.leadSilenceMs as number)) : null,
      a.vocalRanges != null ? JSON.stringify(a.vocalRanges) : null,
      placed, outro != null ? JSON.stringify(outro) : null,
      placed, Number.isFinite(a.tailSilenceMs as number) ? Math.max(0, Math.round(a.tailSilenceMs as number)) : null,
      placed, Number.isFinite(a.tailStartMs as number) ? Math.max(0, Math.round(a.tailStartMs as number)) : null,
      placed, outro != null ? 1 : null,
      a.stemsAttempted ? new Date().toISOString() : null,
      ANALYSIS_VERSION,
      id,
    );
  // Mirror into track_facet_status in the same transaction. Only what this
  // pass actually measured is "fresh"; a tail/vocal kept by COALESCE keeps the
  // version it was measured at. Every analysis pass decodes for the tail, so a
  // tail it could not measure is still an answer at the current version
  // (`tried`), while a tail kept from an earlier pass is not re-promoted.
  const fresh: Facet[] = ['head'];
  // The window loudness only counts as measured where it was written.
  if (!wholeFileLoudness) fresh.push('loudness');
  if (a.outro != null || Number.isFinite(a.tailSilenceMs as number)) fresh.push('tail');
  if (a.vocalRanges != null && !carriedTailVocal) fresh.push('vocal');
  if (a.stemsAttempted) fresh.push('stems');
  syncTrackFacets(id, {
    fresh,
    tried: ['tail'],
    source: a.source ?? 'unknown',
    tailReason: a.source === 'capped' ? 'capped-download' : undefined,
    tailUnplaced: !placedAnswer,
  });
  markTextVectorDirtyIfSoundChanged(id, ['measured']);
  })();
}

// Whether this track's loudness figures come from the whole file (loudness
// v2), which nothing measuring less may overwrite (facets.ts, the one rule).
function hasWholeFileLoudness(id: string): boolean {
  const row = requireDb()
    .prepare<[string], { v: number }>(`SELECT ${SQL_WHOLE_FILE_LOUDNESS} AS v FROM tracks WHERE id = ?`)
    .get(id);
  return row?.v === 1;
}

// SET clauses for the columns only a whole-file figure carries: kept where the
// row's figure is the whole-file one, else NULL; or NULL outright.
const KEEP_WHOLE_FILE_EXTRAS = WHOLE_FILE_LOUDNESS_EXTRAS
  .map((c) => `${c} = CASE WHEN ${SQL_WHOLE_FILE_LOUDNESS} THEN ${c} END`).join(', ');
const CLEAR_WHOLE_FILE_EXTRAS = WHOLE_FILE_LOUDNESS_EXTRAS.map((c) => `${c} = NULL`).join(', ');

// One facet-protocol answer, already mapped to column values. A key is
// present for each facet the backend measured (ok) or proved unmeasurable;
// facets that came back unavailable are simply absent (nothing to record).
export interface FacetWrite {
  head?: {
    bpm: number | null;
    musicalKey: string | null;
    introMs: number | null;
    confidence: number | null;
    sections: TrackSection[] | null;
    pace: TrackPaceSpan[] | null;
    beats: number[] | null;
    bars: number[] | null;
    keyRanges: TrackKeyRange[] | null;
    leadSilenceMs: number | null;
  };
  // `version` 2 = measured over the whole file (with sample peak + LRA); absent
  // = an older analyzer's window figure, which never replaces a v2 one.
  loudness?: {
    loudnessLufs: number | null;
    peakDb: number | null;
    samplePeakDb?: number | null;
    loudnessRangeLu?: number | null;
    version?: number | null;
    // The same pass's short-term curve (whole-loudness-curve.ts); a v2 figure
    // stored without one stays one version below (facets.ts, `no-curve`)...
    curve?: WholeLoudnessCurve | null;
    // ...unless the analyzer ran and had none to give: stored as the
    // unavailable marker, which settles it (unavailableCurveJson).
    curveUnavailable?: string | null;
  } | { unmeasurable: string };
  // `version` 2 = the analyzer placed the window from the stored edges; absent
  // = the end-of-file window (an older analyzer, or no edges to place it).
  tail?: { outro: TrackOutro | null; tailSilenceMs: number | null; tailStartMs: number | null; version?: number | null }
    | { unmeasurable: string };
  clap?: number[];
  // `tailWindow` = where `tailVocalRanges` were measured: 'placed' (the
  // analyzer's tail_window "edges"), 'end' (the file's last seconds; also an
  // older analyzer, which says nothing) or 'stored' (read off the stored or
  // new outro itself: the lyric path).
  vocal?: { vocalRanges: TrackSection[]; tailVocalRanges: TrackSection[] | null; tailWindow?: 'placed' | 'end' | 'stored' };
  stems?: { attempted: true };
  // Silence at both ends (absolute floor) and the decoded length, ms.
  edges?: { leadMs: number; tailMs: number; durationMs: number };
  unmeasurable?: Partial<Record<Facet, string>>;
  // Set when any requested facet failed: counts one failed attempt for the
  // track, exactly like a failed flat analysis. Absent = every facet answered,
  // which clears the failure history like a flat success.
  failed?: string;
  source: FacetSource;
  // The tail was asked for without a placement (no edges stored): an
  // unmeasurable answer then stays due (deriveFacetRows).
  tailUnplaced?: boolean;
}

const finite = (v: unknown): number | null => (Number.isFinite(v as number) ? (v as number) : null);
const jsonOrNull = (v: unknown[] | null | undefined): string | null => (v && v.length ? JSON.stringify(v) : null);

// Per-facet column writes for a facet-protocol answer, plus the facet rows,
// in one transaction. Only the columns of the facets that answered are
// touched — a tail-only answer never rewrites BPM, key or loudness.
export function writeFacetResults(id: string, w: FacetWrite): void {
  const d = requireDb();
  d.transaction(() => {
    const fresh: Facet[] = [];
    const tried: Facet[] = FACETS.filter(f => w.unmeasurable?.[f] != null);
    const unmeasurable: Partial<Record<Facet, string>> = { ...w.unmeasurable };
    let carriedTailVocal = false;
    if (w.head) {
      const h = w.head;
      d.prepare(
        `UPDATE tracks SET bpm = ?, musical_key = ?, intro_ms = ?, analysis_confidence = ?,
           structure_json = ?, pace_json = ?, beats_json = ?, bars_json = ?, key_ranges_json = ?,
           lead_silence_ms = ?, analysis_version = ?
         WHERE id = ?`,
      ).run(
        finite(h.bpm), h.musicalKey ?? null,
        finite(h.introMs) != null ? Math.round(h.introMs as number) : null,
        finite(h.confidence),
        jsonOrNull(h.sections), jsonOrNull(h.pace), jsonOrNull(h.beats), jsonOrNull(h.bars), jsonOrNull(h.keyRanges),
        finite(h.leadSilenceMs) != null ? Math.max(0, Math.round(h.leadSilenceMs as number)) : null,
        ANALYSIS_VERSION, id,
      );
      fresh.push('head');
    }
    if (w.loudness) {
      if (!('unmeasurable' in w.loudness)) {
        const l = w.loudness;
        const version = finite(l.version);
        if (isWholeFileLoudnessVersion(version)) {
          // One measurement: the four figures (and the curve) written together.
          d.prepare(
            `UPDATE tracks SET loudness_lufs = ?, peak_db = ?, sample_peak_db = ?, loudness_range_lu = ?,
               loudness_version = ?, loudness_curve_json = ? WHERE id = ?`,
          ).run(finite(l.loudnessLufs), finite(l.peakDb), finite(l.samplePeakDb), finite(l.loudnessRangeLu),
            Math.round(version),
            l.curve ? JSON.stringify(l.curve) : l.curveUnavailable ? unavailableCurveJson(l.curveUnavailable) : null, id);
          fresh.push('loudness');
        } else if (!hasWholeFileLoudness(id)) {
          d.prepare(`UPDATE tracks SET loudness_lufs = ?, peak_db = ?, ${CLEAR_WHOLE_FILE_EXTRAS} WHERE id = ?`)
            .run(finite(l.loudnessLufs), finite(l.peakDb), id);
          fresh.push('loudness');
        }
      } else {
        tried.push('loudness');
        unmeasurable.loudness = w.loudness.unmeasurable;
      }
    }
    if (w.tail) {
      if ('unmeasurable' in w.tail) {
        unmeasurable.tail = w.tail.unmeasurable;
        tried.push('tail');
      } else {
        let outro = w.tail.outro;
        const tailVersion = finite(w.tail.version);
        if (outro && w.vocal?.tailVocalRanges == null) {
          const kept = preserveTailVocal(id, outro, tailVersion != null && tailVersion >= 2);
          carriedTailVocal = kept !== outro;
          outro = kept;
        }
        // A fresh measurement off a proven end: overwrite, never COALESCE.
        d.prepare('UPDATE tracks SET outro_json = ?, tail_silence_ms = ?, tail_start_ms = ?, tail_version = ? WHERE id = ?').run(
          outro ? JSON.stringify(outro) : null,
          finite(w.tail.tailSilenceMs) != null ? Math.max(0, Math.round(w.tail.tailSilenceMs as number)) : null,
          finite(w.tail.tailStartMs) != null ? Math.max(0, Math.round(w.tail.tailStartMs as number)) : null,
          tailVersion != null && tailVersion >= 2 ? Math.round(tailVersion) : null,
          id,
        );
        fresh.push('tail');
        if (w.tail.outro?.vocalRanges != null) {
          // Tail vocals complete a head-only row, which then counts as measured
          // now only if its head was: a head-only row measured under the current
          // vocal rule is stored one below current. An older one (#2237: a head
          // judged at the old mix floor, with shifted separation) completes but
          // keeps its older version, so it stays due for a re-measure.
          const prior = d.prepare<[string], { reason: string | null; version: number }>(
            "SELECT reason, version FROM track_facet_status WHERE track_id = ? AND facet = 'vocal'",
          ).get(id);
          if (prior?.reason === 'head-only' && prior.version >= FACET_VERSIONS.vocal - 1) fresh.push('vocal');
        }
      }
    }
    if (w.vocal) {
      d.prepare('UPDATE tracks SET vocal_ranges_json = ? WHERE id = ?').run(JSON.stringify(w.vocal.vocalRanges), id);
      // Merged only into an outro on the window they were measured on
      // (sameTailWindow): a vocal-only answer measured on the placed window,
      // over a stored end-of-file outro, would describe music the outro does
      // not hold. Left out, the vocal row stays head-only and the tail backfill
      // places the tail, which measures them again.
      const vocalOnStored = w.vocal.tailWindow === 'stored' ||
        sameTailWindow(storedTailPlaced(id), w.vocal.tailWindow === 'placed');
      if (w.vocal.tailVocalRanges && vocalOnStored) {
        const row = d.prepare('SELECT outro_json FROM tracks WHERE id = ?').get(id) as { outro_json: string | null } | undefined;
        if (row?.outro_json) {
          try {
            const outro = JSON.parse(row.outro_json);
            outro.vocalRanges = w.vocal.tailVocalRanges;
            d.prepare('UPDATE tracks SET outro_json = ? WHERE id = ?').run(JSON.stringify(outro), id);
          } catch { /* a corrupt outro keeps its old value */ }
        }
      }
      if (!carriedTailVocal) fresh.push('vocal');
    }
    if (w.stems) {
      d.prepare('UPDATE tracks SET stems_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      fresh.push('stems');
    }
    if (w.edges) {
      const ms = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
      const before = d.prepare('SELECT edge_tail_ms, decoded_duration_ms, tail_version FROM tracks WHERE id = ?').get(id) as
        { edge_tail_ms: number | null; decoded_duration_ms: number | null; tail_version: number | null } | undefined;
      d.prepare('UPDATE tracks SET edge_lead_ms = ?, edge_tail_ms = ?, decoded_duration_ms = ? WHERE id = ?')
        .run(ms(w.edges.leadMs), ms(w.edges.tailMs), ms(w.edges.durationMs), id);
      fresh.push('edges');
      // A tail placed for where the music stopped before: when the re-measured
      // edges move that end by more than the placement tolerance, the stored
      // tail sits on a window that no longer ends at the music, so it is due
      // again (tail_version 1, tailPlacementMoved). A tail placed in this same
      // answer was placed from these edges.
      if (before && (before.tail_version ?? 1) >= 2 && !fresh.includes('tail') &&
        tailPlacementMoved(before, { edge_tail_ms: ms(w.edges.tailMs), decoded_duration_ms: ms(w.edges.durationMs) })) {
        d.prepare('UPDATE tracks SET tail_version = 1 WHERE id = ?').run(id);
      }
    }
    if (w.failed) {
      d.prepare(
        `UPDATE tracks SET analyze_error = ?, analyze_failed_at = ?,
           analyze_fail_count = COALESCE(analyze_fail_count, 0) + 1 WHERE id = ?`,
      ).run(w.failed.slice(0, 500), new Date().toISOString(), id);
    } else {
      d.prepare(
        'UPDATE tracks SET analyze_error = NULL, analyze_failed_at = NULL, analyze_fail_count = NULL WHERE id = ?',
      ).run(id);
    }
    syncTrackFacets(id, { fresh, tried, source: w.source, unmeasurable, tailUnplaced: w.tailUnplaced });
    if (w.clap) upsertTrackAudioVector(id, w.clap);
    // Only the facets that write a measured word's columns: a stems-only or
    // loudness-only answer moved none, so it never marks.
    if (w.head || w.vocal || (w.tail && !('unmeasurable' in w.tail))) {
      markTextVectorDirtyIfSoundChanged(id, ['measured']);
    }
  })();
}

// A complete stem set that is on disk without this row having asked for it: the
// purge handing a track its dir back. Says only that the stems exist, so it
// leaves the track's analysis failure history alone, which writeFacetResults
// would clear as a success.
export function stampStemsCached(id: string): void {
  const d = requireDb();
  d.transaction(() => {
    d.prepare('UPDATE tracks SET stems_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    syncTrackFacets(id, { fresh: ['stems'], source: 'unknown' });
  })();
}

// Never analysed, or analysed by an older ANALYSIS_VERSION, minus the ones
// judged unanalysable. Ordered for stable resumption.
export function needsAnalysisIds(limit?: number): string[] {
  const sql =
    `SELECT id FROM tracks
       WHERE (analysis_version IS NULL OR analysis_version < ?)
         AND ${analysisFailureExclusion()}
       ORDER BY id` + (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(sql).all(ANALYSIS_VERSION) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Stamp a failed attempt; `error` is trimmed for the admin panel.
export function recordAnalysisFailure(id: string, error: string): void {
  const d = requireDb();
  d.transaction(() => {
    d.prepare(
      `UPDATE tracks SET
         analyze_error      = ?,
         analyze_failed_at  = ?,
         analyze_fail_count = COALESCE(analyze_fail_count, 0) + 1
       WHERE id = ?`,
    ).run((error || 'analysis failed').slice(0, 500), new Date().toISOString(), id);
    // Every facet the track still lacks becomes 'failed' with this count.
    syncTrackFacets(id);
  })();
}

// Forget the failure history for one track (or all, id omitted) so the next pass
// picks it up again. Returns the number of rows cleared.
export function clearAnalysisFailures(id?: string): number {
  const d = requireDb();
  const set = `analyze_error = NULL, analyze_failed_at = NULL, analyze_fail_count = NULL`;
  // One transaction with its facet mirror, like every other write here.
  return d.transaction(() => {
    const res = id
      ? d.prepare(`UPDATE tracks SET ${set} WHERE id = ?`).run(id)
      : d.prepare(`UPDATE tracks SET ${set} WHERE analyze_fail_count IS NOT NULL`).run();
    clearFacetFailures(id);
    return res.changes;
  })();
}

// How many tracks are out of scope for having failed too often (coverage badge).
// The bare comparison, not analysisFailureExclusion()'s COALESCE, so it reads
// idx_tracks_fail_count (#1937); same rows while MAX_ANALYSIS_FAILURES > 0,
// since a NULL count is a 0.
export function analysisFailedCount(): number {
  return (requireDb().prepare(
    `SELECT COUNT(*) AS n FROM tracks WHERE analyze_fail_count >= ${MAX_ANALYSIS_FAILURES}`,
  ).get() as { n: number }).n;
}

export interface AnalysisFailureRow {
  id: string;
  title: string | null;
  artist: string | null;
  error: string | null;
  failedAt: string | null;
  attempts: number;
  // Hit MAX_ANALYSIS_FAILURES and left every scope.
  excluded: boolean;
}

// Tracks that have failed analysis at least once, worst and most recent first.
export function analysisFailures(limit = 200): AnalysisFailureRow[] {
  const rows = requireDb()
    .prepare(
      `SELECT id, title, artist, analyze_error, analyze_failed_at, analyze_fail_count
         FROM tracks
        WHERE COALESCE(analyze_fail_count, 0) > 0
        ORDER BY analyze_fail_count DESC, analyze_failed_at DESC
        LIMIT ${Math.max(1, Math.floor(limit))}`,
    )
    .all() as Array<{
      id: string;
      title: string | null;
      artist: string | null;
      analyze_error: string | null;
      analyze_failed_at: string | null;
      analyze_fail_count: number | null;
    }>;
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    artist: r.artist,
    error: r.analyze_error,
    failedAt: r.analyze_failed_at,
    attempts: r.analyze_fail_count || 0,
    excluded: (r.analyze_fail_count || 0) >= MAX_ANALYSIS_FAILURES,
  }));
}

// Drop the acoustic analysis so a --re-analyze can recompute it. `keepVocal`
// preserves vocal_ranges_json when the slow Demucs pass won't be rerun, and the
// tail measurement with it: outro_json carries the tail window's vocalRanges,
// the other half of the instrumental verdict (lyric-vocal.isInstrumental), so
// clearing it flipped every instrumental-head, sung-tail row to instrumental
// until a vocal-on pass measured it again (#2255). The pass overwrites the tail
// through upsertTrackAnalysis's COALESCE, carrying these ranges forward
// (preserveTailVocal); a row it hasn't reached keeps its old outro. The two tail
// columns ride the outro decode and share its rule.
// `clearStems` is the mirror: only a pass that will rewrite stems may reset the
// stamps, or the whole library re-separates when the cache is next enabled.
export function clearAnalysis(opts: { keepVocal?: boolean; clearStems?: boolean } = {}): void {
  const d = requireDb();
  const vocalCol = opts.keepVocal ? '' : ' vocal_ranges_json = NULL,';
  // keepVocal keeps the tail with the vocal evidence it carries (#2255). A tail
  // placed from the edges (tail_version >= 2) is kept either way, like
  // whole-file loudness: a flat analysis can only re-measure the end-of-file
  // window.
  const keepPlacedTail = (col: string) => ` ${col} = CASE WHEN COALESCE(tail_version, 1) >= 2 THEN ${col} END,`;
  const tailCols = opts.keepVocal ? '' : ['outro_json', 'tail_silence_ms', 'tail_start_ms', 'tail_version'].map(keepPlacedTail).join('');
  const stemsCol = opts.clearStems ? ' stems_at = NULL,' : '';
  d.transaction(() => {
  d.prepare(
    `UPDATE tracks SET bpm = NULL, musical_key = NULL, intro_ms = NULL,
      analysis_confidence = NULL,
      -- Whole-file loudness (v2) is not the analysis being redone: kept, like
      -- the edges columns, which this clear does not touch.
      loudness_lufs = CASE WHEN ${SQL_WHOLE_FILE_LOUDNESS} THEN loudness_lufs END,
      peak_db = CASE WHEN ${SQL_WHOLE_FILE_LOUDNESS} THEN peak_db END,
      ${KEEP_WHOLE_FILE_EXTRAS},
      structure_json = NULL, pace_json = NULL, beats_json = NULL, bars_json = NULL,
      key_ranges_json = NULL,
      lead_silence_ms = NULL,${tailCols}${vocalCol}${stemsCol} analysis_version = NULL,
      audio_moods = NULL, audio_mood_scores_json = NULL,
      audio_descriptors = NULL, audio_descriptor_scores_json = NULL,
      -- The failure history goes with the analysis it describes, or the tracks
      -- most in need of a retry would be the only ones skipped.
      analyze_error = NULL, analyze_failed_at = NULL, analyze_fail_count = NULL`,
  ).run();
  // CLAP vectors are written in the same pass, and the audio moods and
  // descriptors cleared above are derived from them.
  d.prepare('DELETE FROM track_audio_vectors').run();
  clearFacetRows(opts);
  })();
}

// `builtSound` is the Sound: words the vector's text was built from
// (sound-line.soundWords), stored beside it for markTextVectorDirtyIfSoundChanged.
// Omitted = unknown (NULL), which no later measurement marks.
export function upsertTrackVector(
  id: string,
  vector: number[] | Float32Array,
  expectedEraYear: number | null,
  builtSound?: SoundWords | null,
): void {
  if (getEmbeddingDim() === null) {
    throw new Error('library-db opened without embedding dim');
  }
  if (vector.length !== getEmbeddingDim()) {
    throw new Error(
      `vector dim ${vector.length} != schema dim ${getEmbeddingDim()}; run --reseed if you changed embedding model`,
    );
  }
  const buf = Buffer.from(
    vector instanceof Float32Array ? vector.buffer : new Float32Array(vector).buffer,
  );
  // vec0 tables don't support INSERT OR REPLACE; delete + insert is the
  // documented upsert pattern.
  const d = requireDb();
  d.prepare(`DELETE FROM track_vectors WHERE id = ?`).run(id);
  d.prepare(`INSERT INTO track_vectors (id, embedding) VALUES (?, ?)`).run(id, buf);
  touchGenreInputs(d);
  // Embedding is an external await: compare the era this vector was built from
  // against the row at completion, so a stale writer can't clear the refresh
  // marker a concurrent metadata/manual edit set.
  d.transaction(() => {
    d.prepare(
      `UPDATE tracks
          SET text_vector_dirty = CASE
            WHEN (CASE
              WHEN original_year > 0 THEN original_year
              WHEN is_compilation = 1 OR era_untrusted = 1 THEN NULL
              WHEN year > 0 THEN year
              ELSE NULL
            END) IS ? THEN 0 ELSE 1 END,
            text_vector_sound = ?
        WHERE id = ?`,
    ).run(expectedEraYear, builtSound ? JSON.stringify(builtSound) : null, id);
    // The same check for the Sound: words, after the era CASE, which would reset
    // its mark: a measurement written during the await was compared against the
    // old vector, or found no vector to mark.
    if (builtSound) markTextVectorDirtyIfSoundChanged(id, ['moods', 'measured']);
  })();
}

export function dropVectors(): void {
  if (getEmbeddingDim() === null) throw new Error('library-db not opened');
  const d = requireDb();
  runDdl(d, 'DROP TABLE IF EXISTS track_vectors');
  runDdl(d,
    `CREATE VIRTUAL TABLE track_vectors USING vec0(` +
      `id TEXT PRIMARY KEY, embedding FLOAT[${getEmbeddingDim()}] distance_metric=cosine)`,
  );
  touchGenreInputs(d);
  d.prepare(`UPDATE tracks SET text_vector_dirty = 0, text_vector_sound = NULL`).run();
}

// Independent of getEmbeddingDim() (that is the TEXT index): the audio space is
// fixed at AUDIO_EMBEDDING_DIM.
export function upsertTrackAudioVector(id: string, vector: number[] | Float32Array): void {
  if (vector.length !== AUDIO_EMBEDDING_DIM) {
    throw new Error(
      `audio vector dim ${vector.length} != ${AUDIO_EMBEDDING_DIM} (CLAP); ` +
        `check CLAP_MODEL / the analyzer's audio_embedding output`,
    );
  }
  const buf = Buffer.from(
    vector instanceof Float32Array ? vector.buffer : new Float32Array(vector).buffer,
  );
  const d = requireDb();
  d.transaction(() => {
    d.prepare(`DELETE FROM track_audio_vectors WHERE id = ?`).run(id);
    d.prepare(`INSERT INTO track_audio_vectors (id, embedding) VALUES (?, ?)`).run(id, buf);
    syncTrackFacets(id, { fresh: ['clap'], source: 'analyzer' });
  })();
}
