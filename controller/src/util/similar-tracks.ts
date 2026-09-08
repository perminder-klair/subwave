// Pure decisions behind GET /similar-tracks (#1575), the listener-facing
// "sounds like this" lookup over the CLAP index. Two contracts:
//
//   1. Empty-with-a-reason: the route always answers 200, and the reason
//      distinguishes "no CLAP index" / "unknown seed" / "seed not analysed".
//   2. The PUBLIC track shape carries only fields some existing unauthenticated
//      or admin read already publishes. Nothing tagger-internal — no provenance,
//      era-trust flags or `audioMoods`. Adding a field here publishes it to the
//      internet.
//
// The blocklist is NOT applied here: `library.tracksLikeThisAudio` already runs
// every row through `blocklist.rejectBlocked`.
import { resolveEraYear } from '../music/era-year.js';
import { isInstrumental } from '../music/lyric-vocal.js';

// The default matches subwave_search_library's 12-result page.
export const SIMILAR_LIMIT_DEFAULT = 12;
export const SIMILAR_LIMIT_MAX = 50;

// Pull a wide KNN and cap AFTER the archive/blocklist filters, so junk rows
// don't eat result slots.
export const SOUND_KNN_FLOOR = 60;

export function parseSimilarLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return SIMILAR_LIMIT_DEFAULT;
  return Math.min(Math.max(n, 1), SIMILAR_LIMIT_MAX);
}

// Shared by BOTH audio-KNN reads: /similar-tracks and the admin
// /library/search-sound. Never inline a second copy.
export function soundKnnWidth(limit: number): number {
  return Math.max(limit * 2, SOUND_KNN_FLOOR);
}

export type SimilarReason =
  | 'ok'
  | 'no-audio-index'
  | 'seed-not-found'
  | 'seed-not-analysed'
  | 'no-neighbours';

export interface SimilarOutcomeInputs {
  /** library.stats().withAudioEmbedding — how many tracks carry a CLAP vector. */
  audioIndexSize: number;
  /**
   * library.stats().mirrorTotal, NOT `total` — `total` counts only tracks the
   * tagger has reached, and analysis can run ahead of tagging.
   */
  libraryTotal: number;
  /** A library track matched the id (or the free-text seed). */
  seedFound: boolean;
  /** That track carries a CLAP audio vector. */
  seedHasVector: boolean;
  /** Rows left after blocklist, station-archive filter and self-exclusion. */
  neighbourCount: number;
}

export interface SimilarOutcome {
  reason: SimilarReason;
  /** Operator/agent-readable explanation; null when there is nothing to say. */
  message: string | null;
}

// Order matters: widest cause first.
export function similarTracksOutcome(i: SimilarOutcomeInputs): SimilarOutcome {
  const coverage = `audio analysis covers ${i.audioIndexSize} of ${i.libraryTotal} tracks`;
  if (i.audioIndexSize <= 0) {
    return {
      reason: 'no-audio-index',
      message:
        'no track in this library has an audio fingerprint yet — sounds-like needs the ' +
        'heavy analyzer (ANALYZER_HEAVY=1) and a completed analysis pass.',
    };
  }
  if (!i.seedFound) {
    return { reason: 'seed-not-found', message: 'no track in the library matched that seed.' };
  }
  if (!i.seedHasVector) {
    return {
      reason: 'seed-not-analysed',
      message: `the seed track has no audio fingerprint yet (${coverage}).`,
    };
  }
  if (i.neighbourCount <= 0) {
    return {
      reason: 'no-neighbours',
      message:
        'the seed is analysed, but nothing close to it survived filtering (the ' +
        'never-play list, the station archive, and the seed itself).',
    };
  }
  return { reason: 'ok', message: null };
}

/** The narrow row shape the KNN hands back (library slimTrack + `_similarity`). */
export interface SimilarSourceRow {
  id?: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | null;
  originalYear?: number | null;
  yearUntrusted?: boolean | null;
  genres?: string[] | null;
  genre?: string | null;
  moods?: string[] | null;
  energy?: string | null;
  durationSec?: number | null;
  bpm?: number | null;
  musicalKey?: string | null;
  vocalRanges?: unknown[] | null;
  _similarity?: number | null;
}

export interface PublicSimilarTrack {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  genres: string[];
  duration: number | null;
  moods: string[];
  energy: string | null;
  bpm: number | null;
  musicalKey: string | null;
  instrumental: boolean | null;
  similarity: number | null;
}

export function publicSimilarTrack(t: SimilarSourceRow): PublicSimilarTrack {
  return {
    id: String(t.id ?? ''),
    title: t.title ?? null,
    artist: t.artist ?? null,
    album: t.album ?? null,
    // Era year, never the raw `year` (#1418).
    year: resolveEraYear(t.year, t.originalYear, t.yearUntrusted),
    // Comma-joined scalar alongside the full list, the pairing /now-playing publishes.
    genre: t.genres?.length ? t.genres.join(', ') : t.genre ?? null,
    genres: t.genres ?? [],
    duration: t.durationSec ?? null,
    moods: t.moods ?? [],
    energy: t.energy ?? null,
    bpm: t.bpm ?? null,
    musicalKey: t.musicalKey ?? null,
    // [] = analysed, no vocals detected; null = never analysed.
    instrumental: isInstrumental(t.vocalRanges),
    similarity: typeof t._similarity === 'number' ? t._similarity : null,
  };
}
