// Lyric-derived vocal activity (#1125): synced lyric timings turned into the same
// {startMs,endMs} ranges the Demucs detector emits. Usable timed lyrics outrank
// Demucs; anything inconclusive returns null and the caller falls back to it.

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
  instrumental: boolean; // true → vocalRanges is []
  vocalRanges: Section[]; // [] for an instrumental
  introMs: number | null; // first vocal onset, or null for an instrumental
}

// The one reading of the vocalRanges column. Tri-state: [] = analysed, no
// singing; null/undefined = never analysed. `!ranges?.length` conflates them.
export function isInstrumental(vocalRanges: unknown[] | null | undefined): boolean | null {
  return vocalRanges == null ? null : vocalRanges.length === 0;
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

  return { instrumental: false, vocalRanges: ranges, introMs: ranges[0].startMs };
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
