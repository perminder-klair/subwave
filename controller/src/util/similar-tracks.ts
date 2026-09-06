// Pure decisions behind GET /similar-tracks (#1575) — the listener-facing
// "sounds like this" lookup over the CLAP audio-embedding index.
//
// Two things live here rather than inline in the route, both because they are
// the part that can be wrong in a way a running station never shouts about:
//
//   1. The EMPTY-WITH-A-REASON contract. A station with the lean analyzer, a
//      library mid-analysis, and a seed nobody has heard of are three different
//      answers that all return zero tracks. Collapsing them into a bare `[]`
//      (or into a 503, which is what the admin sound-search route does) leaves
//      an API consumer unable to tell "ask me again after the analysis pass"
//      from "your track id is wrong". The route always answers 200; the reason
//      carries the difference.
//   2. The PUBLIC track shape. This endpoint is reachable by listeners, so
//      every field it carries is one some EXISTING unauthenticated or admin
//      read already publishes: the scalars of /now-playing (`genre`/`genres`,
//      `moods`, `energy`, `bpm`, `musicalKey`, the era `year`) plus `album`,
//      `duration`, `instrumental` and `similarity` from the admin sound-search
//      row. Nothing tagger-internal — no provenance (`source`,
//      `originalYearSource`), no era-trust flags, no blocklist annotation
//      (blocked rows are already gone, see below), and no `audioMoods`: the
//      CLAP-derived labels are an admin-console surface (/library/browse) and
//      this route is NOT the place they first go public. Widening it is the
//      bug; adding a field here publishes it to the internet.
//
// The blocklist is NOT applied here. `library.tracksLikeThisAudio` already runs
// every row through `blocklist.rejectBlocked` — the existing chokepoint — and a
// second filter at this call site is exactly the duplication the root CLAUDE.md
// warns about.
import { resolveEraYear } from '../music/era-year.js';
import { isInstrumental } from '../music/lyric-vocal.js';

// Result-count bounds. The default matches subwave_search_library's 12-result
// page; the cap keeps a single call from walking a large KNN for a caller who
// typed a big number.
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

// Shared by BOTH audio-KNN reads — /similar-tracks here and the admin
// /library/search-sound — because they cap the same way for the same reason
// and two inlined copies of `Math.max(limit * 2, 60)` drift the moment either
// gains a filter. Not named "similar*": search-sound is the other caller.
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
   * library.stats().mirrorTotal — every row in the library mirror, for the
   * coverage sentence. NOT `total`, which counts only tracks the TAGGER has
   * reached: the analyzer writes CLAP vectors on its own schedule, so on a
   * station where analysis has run ahead of tagging `withAudioEmbedding`
   * exceeds `total` and the sentence reads "covers 900 of 500 tracks".
   */
  libraryTotal: number;
  /** A library track matched the id (or the free-text seed). */
  seedFound: boolean;
  /** That track carries a CLAP audio vector. */
  seedHasVector: boolean;
  /**
   * Rows left after the blocklist chokepoint, the station-archive filter and
   * the seed's own self-exclusion — i.e. what the caller actually receives.
   */
  neighbourCount: number;
}

export interface SimilarOutcome {
  reason: SimilarReason;
  /** Operator/agent-readable explanation; null when there is nothing to say. */
  message: string | null;
}

// Order matters: the widest cause first, so a station with no CLAP index at all
// is told THAT rather than "your seed isn't analysed" for every track it owns.
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
    // Era year, never the raw `year` (#1418). Every listener-facing year goes
    // through the resolver — a reissue anthology's own release date is
    // untrusted, and this row is rendered by whatever the operator's agent is
    // building. The admin sound-search route publishes the raw year alongside
    // the trust flags instead, because an operator reviewing tags needs both.
    year: resolveEraYear(t.year, t.originalYear, t.yearUntrusted),
    // Comma-joined scalar alongside the full list — same pairing /now-playing
    // publishes, so a client can render either without knowing about #929.
    genre: t.genres?.length ? t.genres.join(', ') : t.genre ?? null,
    genres: t.genres ?? [],
    duration: t.durationSec ?? null,
    moods: t.moods ?? [],
    energy: t.energy ?? null,
    bpm: t.bpm ?? null,
    musicalKey: t.musicalKey ?? null,
    // Same derivation as /library/browse: [] = analysed, no vocals detected;
    // null = never analysed.
    instrumental: isInstrumental(t.vocalRanges),
    similarity: typeof t._similarity === 'number' ? t._similarity : null,
  };
}
