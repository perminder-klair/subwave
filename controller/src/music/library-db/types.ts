// The record shapes library-db reads and writes. TrackRow is the raw SQLite
// row; every other type here is the consumer-facing shape rows.ts maps it to.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnergyValue = 'low' | 'medium' | 'high' | null;
export type TagSource = 'llm' | 'propagated' | 'uncertain-llm' | 'legacy-v1' | 'manual';

export interface TrackRecord {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  // Original-release-year surface (issue #842): the track's TRUE first-release
  // year when it differs from the file's `year` tag (reissues, compilation
  // albums). null = unresolved; era filtering falls back to `year` (except on
  // compilations, whose plain year is the compilation's own date — untrusted).
  originalYear: number | null;
  originalYearSource: string | null;      // 'album-tag' | 'musicbrainz' | 'manual'
  originalYearCheckedAt: string | null;   // last lookup attempt, hit or miss
  isCompilation: boolean | null;          // Navidrome album FLAG; null = unknown
  // Derived era suspicion (issue #1418, music/era-suspect.ts): "this album's
  // year is the reissue's, not the recordings'". Kept SEPARATE from
  // isCompilation, which stays the raw Navidrome fact — the flag is false on
  // exactly the reissue anthologies this exists for, so one column cannot be
  // both. null = not yet walked since the migration.
  eraUntrusted: boolean | null;
  // What era resolution actually consults: the flag OR the derived judgement.
  // Composed HERE, once, so no call site re-decides it — resolveEraYear takes
  // this, never `isCompilation`.
  yearUntrusted: boolean | null;
  // Every genre tag on the file (OpenSubsonic multi-value genres). The single
  // source of truth — `genre` below is a generated column over genres[0]
  // (the "primary" tag), kept for the scalar consumers and indexes.
  genres: string[];
  genre: string | null;
  durationSec: number | null;
  lastfmTags: string[] | null;
  lyricExcerpt: string | null;
  enrichedAt: string | null;
  moods: string[];
  energy: EnergyValue;
  source: TagSource | null;
  confidence: number | null;
  taggerVersion: number | null;
  promptHash: string | null;
  model: string | null;
  taggedAt: string | null;
  // Acoustic analysis (music/analyze-library.ts). All nullable — a track that
  // hasn't been analysed reads null and every consumer treats that as "no
  // signal, behave as today".
  bpm: number | null;
  musicalKey: string | null;   // Camelot code, e.g. '8A'
  introMs: number | null;
  analysisConfidence: number | null;
  analysisVersion: number | null;
  loudnessLufs: number | null; // integrated LUFS (BS.1770); null → unity gain
  peakDb: number | null;       // sample peak in dBFS over the analysis window
  structure: TrackSection[] | null; // structural sections over the analysed window
  vocalRanges: TrackSection[] | null; // vocal-presence ranges; [] = instrumental, null = not computed
  pace: TrackPaceSpan[] | null;     // perceptual energy curve (0..1 per span)
  beats: number[] | null;           // per-beat timestamps (ms)
  bars: number[] | null;            // downbeat (bar) timestamps (ms)
  keyRanges: TrackKeyRange[] | null; // per-region key (tonic + mode) over time
  // Zero-shot audio moods — top mood labels from scoring the vocabulary against
  // the track's CLAP audio vector (music/audio-moods.ts). [] until scored;
  // sound-derived, so they complement (never replace) the LLM `moods`.
  audioMoods: string[];
  // Outro (tail) features — the track's measured ending (fade vs cold, tail
  // loudness/tempo/bar grid). null → no outro signal, today's transitions.
  outro: TrackOutro | null;
  // Sound-map coordinates — a 2D UMAP projection of the CLAP audio vector,
  // normalised to [0,1] per axis (music/map-projection.ts). The Observatory
  // places nodes by these when present, so tracks that SOUND alike sit close.
  // null → not projected (no audio vector, or the projection hasn't run).
  mapX: number | null;
  mapY: number | null;
}

// The measured ending of a track — what the crossfade seam actually lands on.
// Timestamps are absolute ms into the track.
export interface TrackOutro {
  startMs: number;           // where the wind-down starts
  ending: 'fade' | 'cold';   // fades to silence vs ends at level
  lufs: number | null;       // integrated tail loudness (BS.1770)
  bpm: number | null;        // tail tempo (outros drift/ritard vs the lead)
  beats: number[] | null;    // tail beat grid (ms)
  bars: number[] | null;     // tail downbeat grid (ms)
  // Tail vocal-activity spans (Demucs over the outro window), absolute ms.
  // [] = analysed instrumental tail (meaningful, distinct from null/absent =
  // not computed) — the same tri-state as the head vocal_ranges_json column.
  // Optional so the analyzer's write shape (which OMITS the key when not
  // computed — the backfill probes outro_json's raw text for it) assigns
  // cleanly; parseOutroJson always materialises it (null) on the read side.
  vocalRanges?: Array<{ startMs: number; endMs: number }> | null;
}

// A key over a time range: tonic note (sharps) + mode.
export interface TrackKeyRange {
  startMs: number;
  endMs: number;
  tonic: string;
  mode: 'major' | 'minor';
}

// A structural span over a track, in milliseconds (span shape). Kept as
// a local shape so library-db stays free of higher-layer imports.
export interface TrackSection {
  startMs: number;
  endMs: number;
  kind?: string;
}

// A pace span: a 0..1 perceptual-energy value over a time range.
export interface TrackPaceSpan {
  startMs: number;
  endMs: number;
  value: number;
}

// The raw `tracks` table row as SQLite hands it back — snake_case columns with
// the acoustic blobs still JSON strings. rowToTrack / rowToObservatory map it
// into the camelCase record types above. Reflects the table schema; the write
// path validates energy/source into their unions, so those read back typed. A
// partial SELECT (getTrackLite, the observatory columns) yields a subset of
// this shape and the mapper only touches columns it actually selected.
export interface TrackRow {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  original_year: number | null;
  original_year_source: string | null;
  original_year_checked_at: string | null;
  is_compilation: number | null;
  era_untrusted: number | null;
  text_vector_dirty: number;
  genres: string | null; // JSON array; `genre` is generated from genres[0]
  genre: string | null;
  duration_sec: number | null;
  lastfm_tags: string | null;
  lyric_excerpt: string | null;
  enriched_at: string | null;
  moods: string | null;
  energy: EnergyValue;
  source: TagSource | null;
  confidence: number | null;
  tagger_version: number | null;
  prompt_hash: string | null;
  model: string | null;
  tagged_at: string | null;
  bpm: number | null;
  musical_key: string | null;
  intro_ms: number | null;
  analysis_confidence: number | null;
  analysis_version: number | null;
  loudness_lufs: number | null;
  peak_db: number | null;
  structure_json: string | null;
  vocal_ranges_json: string | null;
  pace_json: string | null;
  beats_json: string | null;
  bars_json: string | null;
  key_ranges_json: string | null;
  audio_moods: string | null;
  outro_json: string | null;
  map_x: number | null;
  map_y: number | null;
}

export interface TrackMeta {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
  genres?: string[] | null;
  duration?: number | null;
  // Walk-time original-year surface (issue #842/#1418). `originalYear` here is
  // the ALBUM's originalReleaseDate.year (source 'album-tag'), and the walk
  // passes it only when it is INFORMATIVE — not on an era-suspect album, and
  // not when it merely echoes the release year, which tells us nothing and
  // would hide the track from the lookup that can actually answer. Never
  // overwrites a per-track 'musicbrainz' or 'manual' value — see
  // upsertTrackMeta.
  originalYear?: number | null;
  isCompilation?: boolean | null;
  /** music/era-suspect.albumEraSuspect's verdict for this track's album. */
  eraUntrusted?: boolean | null;
}

export interface TrackEnrichment {
  lastfmTags: string[] | null;
  lyricExcerpt: string | null;
}

export interface TagWrite {
  moods: string[];
  energy: EnergyValue;
  source: TagSource;
  confidence?: number | null;
  promptHash?: string | null;
  model?: string | null;
}

export interface FilterOpts {
  moods?: string[];
  energy?: string | null;
  genre?: string | null;
  // Acoustic-analysis facet: 'instrumental' = analysed with an empty vocal-ranges
  // array, 'vocal' = analysed with at least one range. A NULL vocal_ranges_json
  // (not computed) matches neither, so the facet only ever narrows to tracks the
  // analyze pass has actually touched.
  vocal?: 'instrumental' | 'vocal' | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  q?: string | null;
  sort?: 'artist' | 'title' | 'taggedAt' | 'year' | 'bpm' | 'loudness' | 'pace';
  limit?: number;
  offset?: number;
}

export interface LibraryStats {
  // TAGGED tracks (moods present) — the tagging-coverage figure.
  total: number;
  // Every row in the library mirror, tagged or not — the "how big is this
  // library" figure. See computeStats for why the two must not be conflated.
  mirrorTotal: number;
  distinctArtists: number;
  byMood: Record<string, number>;
  byEnergy: Record<string, number>;
  byGenre: Record<string, number>;
  bySource: Record<string, number>;
  withEmbedding: number;
  withAudioEmbedding: number;
  updatedAt: string | null;
}

