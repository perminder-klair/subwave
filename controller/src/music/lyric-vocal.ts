// Lyric-derived vocal activity (#1125): synced lyric timings turned into the same
// {startMs,endMs} ranges the Demucs detector emits. Usable timed lyrics outrank
// Demucs; anything inconclusive returns null and the caller falls back to it.

import { z } from 'zod';

interface LyricLine {
  startMs: number; // milliseconds from track start; NaN when unsynced
  text: string;
}

export interface StructuredLyrics {
  synced: boolean;
  lines: LyricLine[];
}

export interface Section {
  startMs: number;
  endMs: number;
}

export interface LyricVocalResult {
  instrumental: boolean; // duration classification; short spans remain below
  vocalRanges: Section[];
  introMs: number | null; // first measured vocal onset, or null for no spans
}

// #1655: Roman Twilight has 2,961ms of Demucs bleed; 1,881 tracks in the
// reported library have <5s total. Use a fixed tolerance because the measured
// windows need not cover the whole track. Equality remains vocal.
export const INSTRUMENTAL_VOCAL_TOLERANCE_MS = 5_000;
const vocalSection = z.object({
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite(),
  kind: z.unknown().optional(),
}).refine((r) => r.endMs > r.startMs);
const vocalSections = z.array(vocalSection);

// The one track classification rule. Unknown stays unknown; malformed non-empty
// ranges stay vocal rather than granting instrumental eligibility. Timing rules
// still inspect the original spans, including a short phrase below this tolerance.
export function isInstrumental(vocalRanges: unknown[] | null | undefined, vocalRangesInvalid = false): boolean | null {
  if (vocalRangesInvalid) return false;
  if (vocalRanges == null) return null;
  const parsed = vocalSections.safeParse(vocalRanges);
  if (!parsed.success) return false;
  return parsed.data.reduce((ms, r) => ms + r.endMs - r.startMs, 0)
    < INSTRUMENTAL_VOCAL_TOLERANCE_MS;
}

// Keep bad-span evidence beside clean timing spans; dropping it would let a
// partial measurement earn instrumental eligibility after a normal row read.
export function parseVocalRangesJson(json: string | null | undefined): {
  vocalRanges: Array<Section & { kind?: string }> | null;
  vocalRangesInvalid: boolean;
} {
  try {
    const ranges: unknown = json == null ? null : JSON.parse(json);
    if (Array.isArray(ranges)) {
      const vocalRanges: Array<Section & { kind?: string }> = [];
      let vocalRangesInvalid = false;
      for (const range of ranges) {
        const parsed = vocalSection.safeParse(range);
        if (!parsed.success) { vocalRangesInvalid = true; continue; }
        const { startMs, endMs, kind } = parsed.data;
        vocalRanges.push(typeof kind === 'string' ? { startMs, endMs, kind } : { startMs, endMs });
      }
      return { vocalRanges, vocalRangesInvalid };
    }
  } catch { /* unreadable measurements stay unknown */ }
  return { vocalRanges: null, vocalRangesInvalid: false };
}

// Registered as a deterministic SQLite scalar so SQL filters use the JS rule.
export function instrumentalFromJson(json: string | null): number | null {
  const { vocalRanges, vocalRangesInvalid } = parseVocalRangesJson(json);
  const instrumental = isInstrumental(vocalRanges, vocalRangesInvalid);
  return instrumental == null ? null : Number(instrumental);
}

// LRC `[au: instrumental]` / "Instrumental" placeholder. Anchored, so a song that
// merely sings the word isn't caught.
const INSTRUMENTAL_RE = /^\s*[[(]?\s*(?:au\s*:\s*)?instrumental\s*[)\]]?\s*$/i;

// Consecutive sung lines closer than this merge into one range; a wider gap
// splits them so the ranges expose real vocal-free stretches.
const MERGE_GAP_MS = 8_000;
// A line extends to the next line, capped so a long trailing gap reads as an
// instrumental break rather than sustained singing.
const MAX_LINE_MS = 8_000;
// The final line has no successor to bound it — give it a nominal sung tail.
const LAST_LINE_TAIL_MS = 4_000;

// Structured lyrics → vocal ranges + intro cue, or null when inconclusive.
export function deriveVocalFromLyrics(lyrics: StructuredLyrics | null): LyricVocalResult | null {
  if (!lyrics) return null;
  const lines = lyrics.lines.filter((l) => l.text.trim().length > 0);

  if (lines.length > 0 && lines.every((l) => INSTRUMENTAL_RE.test(l.text))) {
    return { instrumental: true, vocalRanges: [], introMs: null };
  }

  // Unsynced text, or a body with no timed lines, is inconclusive.
  if (!lyrics.synced) return null;
  const timed = lines
    .filter((l) => Number.isFinite(l.startMs) && l.startMs >= 0)
    .sort((a, b) => a.startMs - b.startMs);
  if (timed.length === 0) return null;

  const ranges: Section[] = [];
  for (let i = 0; i < timed.length; i++) {
    const start = timed[i].startMs;
    const next = i + 1 < timed.length ? timed[i + 1].startMs : null;
    const end = next != null ? Math.min(next, start + MAX_LINE_MS) : start + LAST_LINE_TAIL_MS;
    const last = ranges[ranges.length - 1];
    if (last && start - last.endMs <= MERGE_GAP_MS) {
      last.endMs = Math.max(last.endMs, end);
    } else {
      ranges.push({ startMs: start, endMs: end });
    }
  }

  return { instrumental: isInstrumental(ranges) === true, vocalRanges: ranges, introMs: ranges[0].startMs };
}

// Clip whole-track ranges into the outro window, the lyric counterpart of the
// worker's tail Demucs pass. Trimmed to the track end when known (the nominal
// last-line tail can outrun it); [] means an instrumental tail.
export function clipRangesToTail(
  ranges: Section[],
  windowStartMs: number,
  endCapMs: number | null = null,
): Section[] {
  return ranges
    .map((r) => ({
      startMs: Math.max(r.startMs, windowStartMs),
      endMs: endCapMs != null ? Math.min(r.endMs, endCapMs) : r.endMs,
    }))
    .filter((r) => r.endMs > r.startMs);
}
