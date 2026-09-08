// Record shapes library-db reads and writes. TrackRow is the raw SQLite row;
// the rest are the consumer-facing shapes rows.ts maps it to.

export type EnergyValue = 'low' | 'medium' | 'high' | null;
export type TagSource = 'llm' | 'propagated' | 'uncertain-llm' | 'legacy-v1' | 'manual';

export interface TrackRecord {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  // Subsonic ids, so the blocklist matches an album/artist entry exactly instead
  // of by normalised name. null = not walked since migration 23.
  albumId: string | null;
  artistId: string | null;
  year: number | null;
  // True first-release year when it differs from the file tag (#842). null =
  // unresolved; era filtering then falls back to `year`.
  originalYear: number | null;
  originalYearSource: string | null;      // 'album-tag' | 'musicbrainz' | 'manual'
  originalYearCheckedAt: string | null;   // last lookup attempt, hit or miss
  isCompilation: boolean | null;          // Navidrome album FLAG; null = unknown
  // Derived era suspicion (#1418). Separate from isCompilation, which is false on
  // exactly the reissue anthologies this exists for.
  eraUntrusted: boolean | null;
  // Flag OR derived judgement, composed once. resolveEraYear takes this, never
  // `isCompilation`.
  yearUntrusted: boolean | null;
  // Source of truth; the scalar `genre` column is GENERATED from genres[0].
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
  // Acoustic analysis; null means no signal and consumers fall back to their
  // unanalysed behaviour.
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
  // Zero-shot audio moods; [] until scored. Complement the LLM `moods`.
  audioMoods: string[];
  // null = no outro signal.
  outro: TrackOutro | null;
  // Edge dead air (ms) against an ABSOLUTE dBFS floor, unlike introMs and
  // outro.startMs which are relative. null = not measured, so trim nothing.
  leadSilenceMs: number | null;
  tailSilenceMs: number | null;
  // Where the trailing gap opens, absolute ms from byte zero (the cue_out). null
  // on pre-column rows; silence-trim.ts falls back to duration - tailSilenceMs.
  tailStartMs: number | null;
  // 2D UMAP of the CLAP audio vector, normalised to [0,1] per axis. null = not
  // projected.
  mapX: number | null;
  mapY: number | null;
}

// The measured ending the crossfade seam lands on. Timestamps are absolute ms.
export interface TrackOutro {
  startMs: number;           // where the wind-down starts
  ending: 'fade' | 'cold';   // fades to silence vs ends at level
  lufs: number | null;       // integrated tail loudness (BS.1770)
  bpm: number | null;        // tail tempo (outros drift/ritard vs the lead)
  beats: number[] | null;    // tail beat grid (ms)
  bars: number[] | null;     // tail downbeat grid (ms)
  // Tail vocal-activity spans, absolute ms. [] = analysed instrumental tail,
  // null/absent = not computed. Optional because the analyzer OMITS the key when
  // not computed (the backfill probes the raw JSON for it); parseOutroJson
  // materialises it as null on read.
  vocalRanges?: Array<{ startMs: number; endMs: number }> | null;
}

// Tonic note (sharps) + mode over a time range.
export interface TrackKeyRange {
  startMs: number;
  endMs: number;
  tonic: string;
  mode: 'major' | 'minor';
}

// Local shape, so library-db imports no higher layer.
export interface TrackSection {
  startMs: number;
  endMs: number;
  kind?: string;
}

// A 0..1 perceptual-energy value over a time range.
export interface TrackPaceSpan {
  startMs: number;
  endMs: number;
  value: number;
}

// The raw `tracks` row: snake_case, acoustic blobs still JSON strings. The write
// path validates energy/source into their unions, so those read back typed. A
// partial SELECT yields a subset and the mappers only touch selected columns.
export interface TrackRow {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  // NULL on any row not walked since migration 23; consumers fall back to names.
  album_id: string | null;
  artist_id: string | null;
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
  lead_silence_ms: number | null;
  tail_silence_ms: number | null;
  tail_start_ms: number | null;
  map_x: number | null;
  map_y: number | null;
}

export interface TrackMeta {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  /** Omitted by the non-walk writers, which have no id to offer. upsertTrackMeta
   *  COALESCEs, so an omitted id never clears a stored one. */
  albumId?: string | null;
  artistId?: string | null;
  year?: number | string | null;
  genres?: string[] | null;
  duration?: number | null;
  // The album's originalReleaseDate.year, source 'album-tag' (#842/#1418). Passed
  // only when informative: not on an era-suspect album, and not when it echoes the
  // release year. Never overwrites a 'musicbrainz' or 'manual' value.
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
  // 'instrumental' = empty vocal-ranges array, 'vocal' = at least one range. NULL
  // matches neither, so the facet only covers analysed tracks.
  vocal?: 'instrumental' | 'vocal' | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  q?: string | null;
  sort?: 'artist' | 'title' | 'taggedAt' | 'year' | 'bpm' | 'loudness' | 'pace';
  limit?: number;
  offset?: number;
}

export interface LibraryStats {
  // TAGGED tracks (moods present), the tagging-coverage figure.
  total: number;
  // Every row in the mirror, tagged or not; not to be conflated with `total`.
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

