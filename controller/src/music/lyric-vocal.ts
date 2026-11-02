// Lyric-derived vocal activity (#1125): synced lyric timings turned into the same
// {startMs,endMs} ranges the Demucs detector emits. Usable timed lyrics outrank
// Demucs; anything inconclusive returns null and the caller falls back to it.
//
// Also the one instrumental verdict. Vocal activity is measured over two windows:
// the opening ANALYZE_SECONDS (tracks.vocal_ranges_json) and the outro (outro_json's
// vocalRanges, absolute ms). A track is instrumental when EACH measured window holds
// under INSTRUMENTAL_VOCAL_TOLERANCE_MS of singing: max(head, tail) < tolerance. A
// max, never a sum or a union: #1655 measured ~3s of bleed in one window, so two
// windows added together would flip real instrumentals, and the windows overlap
// anyway (lyric-derived head ranges span the track and the tail is clipped from
// them; a short track's windows meet). The tail can only move a verdict toward
// vocal, because singing it saw is evidence and silence it saw says nothing about
// the head. Only this classification reads both: timing rules keep their own spans.

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

// What a row carries for the verdict: each window's clean spans and whether any
// stored span was bad. An absent tail is simply a row with no tail evidence.
export interface VocalEvidence {
  vocalRanges?: unknown[] | null;
  vocalRangesInvalid?: boolean;
  tailVocalRanges?: unknown[] | null;
  tailVocalRangesInvalid?: boolean;
}

// Sung ms in one window. null = not measured; malformed non-empty ranges read as
// Infinity, which keeps them vocal rather than granting instrumental eligibility.
function sungMs(ranges: unknown[] | null | undefined, invalid: boolean | undefined): number | null {
  if (invalid) return Infinity;
  if (ranges == null) return null;
  const parsed = vocalSections.safeParse(ranges);
  if (!parsed.success) return Infinity;
  return parsed.data.reduce((ms, r) => ms + r.endMs - r.startMs, 0);
}

// The one track classification rule (header). Equality stays vocal. An unmeasured
// head stays unknown unless the tail proves singing: nothing measured the rest of
// the track. Timing rules still inspect the original spans, including a short
// phrase below this tolerance.
export function isInstrumental(track: VocalEvidence | null | undefined): boolean | null {
  const head = sungMs(track?.vocalRanges, track?.vocalRangesInvalid);
  const tail = sungMs(track?.tailVocalRanges, track?.tailVocalRangesInvalid);
  if (Math.max(head ?? 0, tail ?? 0) >= INSTRUMENTAL_VOCAL_TOLERANCE_MS) return false;
  return head == null ? null : true;
}

// Keep bad-span evidence beside clean timing spans; dropping it would let a
// partial measurement earn instrumental eligibility after a normal row read.
function readVocalRanges(ranges: unknown): {
  vocalRanges: Array<Section & { kind?: string }> | null;
  vocalRangesInvalid: boolean;
} {
  if (!Array.isArray(ranges)) return { vocalRanges: null, vocalRangesInvalid: false };
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

export function parseVocalRangesJson(json: string | null | undefined): ReturnType<typeof readVocalRanges> {
  try {
    return readVocalRanges(json == null ? null : JSON.parse(json));
  } catch { /* unreadable measurements stay unknown */ }
  return readVocalRanges(null);
}

function asTailEvidence({ vocalRanges, vocalRangesInvalid }: ReturnType<typeof readVocalRanges>) {
  return { tailVocalRanges: vocalRanges, tailVocalRangesInvalid: vocalRangesInvalid };
}

// The tail's spans alone, as a bulk read projects them (library-db's
// SQL_TAIL_VOCAL_RANGES) so no beat grid crosses into JS.
export function parseTailVocalRangesJson(json: string | null | undefined) {
  return asTailEvidence(parseVocalRangesJson(json));
}

// The same evidence off the whole outro_json, for a row that already read it.
// Reads the raw key, not parseOutroJson's result: that rejects an outro for its
// other fields and drops bad spans, and either would part JS from the SQL scalar.
export function parseOutroVocalJson(outroJson: string | null | undefined) {
  try {
    const outro = (outroJson == null ? null : JSON.parse(outroJson)) as { vocalRanges?: unknown } | null;
    return asTailEvidence(readVocalRanges(outro?.vocalRanges));
  } catch { /* an unreadable outro is no tail evidence */ }
  return asTailEvidence(readVocalRanges(null));
}

// Registered as a deterministic SQLite scalar so SQL filters use the JS rule.
export function instrumentalFromJson(json: string | null, tailJson: string | null = null): number | null {
  const instrumental = isInstrumental({ ...parseVocalRangesJson(json), ...parseTailVocalRangesJson(tailJson) });
  return instrumental == null ? null : Number(instrumental);
}

// LRC `[au: instrumental]` / "Instrumental" placeholder. Anchored, so a song that
// merely sings the word isn't caught.
const INSTRUMENTAL_RE = /^\s*[[(]?\s*(?:au\s*:\s*)?instrumental\s*[)\]]?\s*$/i;

// Exported so the public lyrics payload (`music/lyrics-public.ts`) screens the
// same markers off the same `getStructuredLyrics()` shape. One owner for the
// pattern — a second copy would drift the moment a new marker spelling shows up.
export function isInstrumentalMarker(text: string): boolean {
  return INSTRUMENTAL_RE.test(text);
}

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

  if (lines.length > 0 && lines.every((l) => isInstrumentalMarker(l.text))) {
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

  return { instrumental: isInstrumental({ vocalRanges: ranges }) === true, vocalRanges: ranges, introMs: ranges[0].startMs };
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
