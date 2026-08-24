// Row → record mapping and the JSON column parsers. Everything stored in a TEXT
// column as JSON is parsed here, defensively — a row written by an older schema
// version must degrade to null rather than throw a query.

import type { TrackKeyRange, TrackOutro, TrackPaceSpan, TrackRecord, TrackRow, TrackSection } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function rowToTrack(row: TrackRow): TrackRecord {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    year: row.year,
    originalYear: row.original_year ?? null,
    originalYearSource: row.original_year_source ?? null,
    originalYearCheckedAt: row.original_year_checked_at ?? null,
    isCompilation: row.is_compilation == null ? null : !!row.is_compilation,
    eraUntrusted: row.era_untrusted == null ? null : !!row.era_untrusted,
    // The composed answer every era consumer reads. OR, not COALESCE: the two
    // columns are independent evidence and either one alone is enough. A row
    // not yet re-walked since the #1418 migration has era_untrusted NULL and
    // still behaves exactly as it did under #842.
    yearUntrusted: (row.is_compilation === 1 || row.era_untrusted === 1)
      ? true
      : (row.is_compilation == null && row.era_untrusted == null ? null : false),
    genres: row.genres ? safeParseArray(row.genres) : [],
    genre: row.genre,
    durationSec: row.duration_sec,
    lastfmTags: row.lastfm_tags ? safeParseArray(row.lastfm_tags) : null,
    lyricExcerpt: row.lyric_excerpt,
    enrichedAt: row.enriched_at,
    moods: row.moods ? safeParseArray(row.moods) : [],
    energy: row.energy ?? null,
    source: row.source ?? null,
    confidence: row.confidence,
    taggerVersion: row.tagger_version,
    promptHash: row.prompt_hash,
    model: row.model,
    taggedAt: row.tagged_at,
    bpm: row.bpm ?? null,
    musicalKey: row.musical_key ?? null,
    introMs: row.intro_ms ?? null,
    analysisConfidence: row.analysis_confidence ?? null,
    analysisVersion: row.analysis_version ?? null,
    loudnessLufs: row.loudness_lufs ?? null,
    peakDb: row.peak_db ?? null,
    structure: row.structure_json ? safeParseSections(row.structure_json) : null,
    // Preserve an empty array ("analysed instrumental"); only a SQL NULL column
    // (not computed) maps to null. parseSpans keeps [] intact.
    vocalRanges: row.vocal_ranges_json != null ? parseSpans(row.vocal_ranges_json) : null,
    pace: row.pace_json ? parsePaceSpans(row.pace_json) : null,
    beats: row.beats_json ? parseMsArray(row.beats_json) : null,
    bars: row.bars_json ? parseMsArray(row.bars_json) : null,
    keyRanges: row.key_ranges_json ? parseKeyRanges(row.key_ranges_json) : null,
    audioMoods: row.audio_moods ? safeParseArray(row.audio_moods) : [],
    outro: row.outro_json ? parseOutroJson(row.outro_json) : null,
    mapX: row.map_x ?? null,
    mapY: row.map_y ?? null,
  };
}

// Parse an outro_json column into TrackOutro or null. Malformed → null.
export function parseOutroJson(s: string): TrackOutro | null {
  try {
    const v = JSON.parse(s);
    const startMs = Number(v?.startMs);
    const ending = v?.ending;
    if (!Number.isFinite(startMs) || startMs < 0) return null;
    if (ending !== 'fade' && ending !== 'cold') return null;
    const msList = (x: unknown): number[] | null =>
      Array.isArray(x) && x.length ? x.filter((n): n is number => Number.isFinite(n)) : null;
    // Tail vocal spans: gate on KEY PRESENCE so absent stays null (not
    // computed) while a present-but-empty array survives as [] (analysed
    // instrumental tail). Malformed entries are dropped span-by-span — a
    // wholesale []-on-malformed would fake the "measured instrumental"
    // meaning and permanently satisfy the backfill's tail-missing probe.
    let vocalRanges: Array<{ startMs: number; endMs: number }> | null = null;
    if (Array.isArray(v?.vocalRanges)) {
      vocalRanges = [];
      for (const r of v.vocalRanges as Record<string, unknown>[]) {
        const s = Number(r?.startMs);
        const e = Number(r?.endMs);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) vocalRanges.push({ startMs: s, endMs: e });
      }
    }
    return {
      startMs: Math.round(startMs),
      ending,
      lufs: Number.isFinite(v?.lufs) ? v.lufs : null,
      bpm: Number.isFinite(v?.bpm) ? v.bpm : null,
      beats: msList(v?.beats),
      bars: msList(v?.bars),
      vocalRanges,
    };
  } catch {
    return null;
  }
}

// Parse a key_ranges_json column into TrackKeyRange[] or null. Empty/malformed → null.
function parseKeyRanges(s: string): TrackKeyRange[] | null {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return null;
    const out: TrackKeyRange[] = [];
    for (const x of v as Record<string, unknown>[]) {
      const startMs = Number(x?.startMs);
      const endMs = Number(x?.endMs);
      const tonic = x?.tonic;
      const mode = x?.mode;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      if (typeof tonic !== 'string' || (mode !== 'major' && mode !== 'minor')) continue;
      out.push({ startMs, endMs, tonic, mode });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// Parse a JSON array of ms timestamps → finite number[] or null (empty → null).
function parseMsArray(s: string): number[] | null {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return null;
    const out = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// Parse a pace_json column into TrackPaceSpan[] or null. Empty/malformed → null.
export function parsePaceSpans(s: string): TrackPaceSpan[] | null {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return null;
    const out: TrackPaceSpan[] = [];
    for (const x of v as Record<string, unknown>[]) {
      const startMs = Number(x?.startMs);
      const endMs = Number(x?.endMs);
      const value = Number(x?.value);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(value) || endMs <= startMs) continue;
      out.push({ startMs, endMs, value });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// Parse a JSON span column into clean TrackSection[] (possibly empty). Drops
// malformed/zero-length spans; returns [] on any parse error.
function parseSpans(s: string): TrackSection[] {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    const out: TrackSection[] = [];
    for (const x of v as Record<string, unknown>[]) {
      const startMs = Number(x?.startMs);
      const endMs = Number(x?.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      const kind = typeof x?.kind === 'string' ? x.kind : undefined;
      out.push(kind ? { startMs, endMs, kind } : { startMs, endMs });
    }
    return out;
  } catch {
    return [];
  }
}

// structure_json: empty collapses to null ("no structure"), unlike vocal ranges.
function safeParseSections(s: string): TrackSection[] | null {
  const out = parseSpans(s);
  return out.length ? out : null;
}

export function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function normaliseYear(y: unknown): number | null {
  if (y == null) return null;
  if (typeof y === 'number' && Number.isFinite(y)) return Math.trunc(y);
  if (typeof y === 'string') {
    const n = parseInt(y, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

