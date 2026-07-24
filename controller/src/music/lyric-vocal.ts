// Lyric-derived vocal activity (issue #1125). Navidrome already indexes timed
// (synced) lyrics — the plain `subsonic.getLyrics()` flattens them to text for
// embeddings and throws the per-line timings away. `getStructuredLyrics()`
// preserves the timings, and this pure module turns them into the same
// {startMs,endMs} vocal ranges the Demucs detector emits.
//
// Why this is worth it: Demucs never separates cleanly, so an instrumental's
// "vocal" stem carries residual bleed (pad swells, cymbals, guitar harmonics)
// that a self-relative energy gate mistakes for singing (the mass false-positive
// in #1125). A synced lyric line is ground truth — the vocal starts exactly when
// the line does. So when a track has usable timed lyrics we skip the detector
// entirely; an explicit "instrumental" marker tags it instrumental for free; and
// anything inconclusive (no lyrics, or unsynced text with no timing) returns
// null so the caller falls back to Demucs (now with the mix-anchored floor).
//
// Pure + side-effect-free: unit-pinned by scripts/lyric-vocal.test.ts.

export interface LyricLine {
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

// A lyric "body" that is really a no-lyrics/instrumental marker, not sung words.
// Covers the LRC `[au: instrumental]` metadata tag some players surface as a
// line and the common single-line "Instrumental" placeholder. Anchored to the
// whole string so a song that merely SINGS the word "instrumental" isn't caught.
const INSTRUMENTAL_RE = /^\s*[[(]?\s*(?:au\s*:\s*)?instrumental\s*[)\]]?\s*$/i;

// Consecutive sung lines closer than this merge into one vocal range; a wider
// gap (a solo, an instrumental bridge) splits them so the ranges expose real
// vocal-free stretches. 8s keeps a verse together but still surfaces breaks.
const MERGE_GAP_MS = 8_000;
// A line extends until the next line, capped so a long trailing gap before the
// next line reads as an instrumental break rather than sustained singing.
const MAX_LINE_MS = 8_000;
// The final line has no successor to bound it — give it a nominal sung tail.
const LAST_LINE_TAIL_MS = 4_000;

// Turn structured lyrics into vocal ranges + an intro cue, or null when the
// input can't decide (caller falls back to Demucs). `null` in / no usable timing
// → null out; an all-marker body → instrumental ([]); synced timed lines →
// merged ranges with the first onset as the intro.
export function deriveVocalFromLyrics(lyrics: StructuredLyrics | null): LyricVocalResult | null {
  if (!lyrics) return null;
  const lines = lyrics.lines.filter((l) => l.text.trim().length > 0);

  // Explicit instrumental marker: every non-empty line is the marker text.
  if (lines.length > 0 && lines.every((l) => INSTRUMENTAL_RE.test(l.text))) {
    return { instrumental: true, vocalRanges: [], introMs: null };
  }

  // Placing vocals in time needs real timestamps; unsynced text or a body with
  // no timed lines is inconclusive — let Demucs handle it.
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

// Clip whole-track vocal ranges into a track's outro window — the lyric
// counterpart of the worker's tail Demucs pass (feature: vocal-aware
// transitions). Spans are trimmed to the window (and to the track end when
// known, since the nominal last-line tail can outrun it); [] = no sung line
// reaches the window, i.e. an instrumental tail, mirroring the worker's
// tri-state semantics.
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
