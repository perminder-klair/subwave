// LRC text → the structured-lyrics shape every lyrics reader here takes
// (`subsonic.fetchStructuredLyrics()`'s). LRCLIB serves its synced lyrics as
// LRC, so this is the one parse of it (music/lyrics-sources.ts).
//
//   [00:12.34]a line              one stamp
//   [00:12.34][01:02.00]chorus    several: the line repeats at each
//   [offset:+250]                 a file-wide shift. LRC's convention, which is
//                                 also how Navidrome applies its own `offset`:
//                                 positive makes lines appear sooner (start − offset)
//   [ar:Artist] [ti:Title]        metadata, dropped
//   <00:12.80>word                word-level stamps, stripped to the plain line
//
// An empty stamped line is kept: in LRC it is where the singing stops, and the
// public payload drops blank lines the same way for every source.
import type { StructuredLyricsInput } from './lyrics-public.js';

const LEAD_STAMP = /^\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]$/i;
const WORD_STAMP = /<\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?>/g;

function stampMs(m: RegExpExecArray): number {
  const min = Number(m[1]);
  const sec = Number(m[2]);
  // The fraction's digit count is its unit: .5 tenths, .50 hundredths, .500 ms.
  const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
  return (min * 60 + sec) * 1000 + frac;
}

/** Timed lyrics from LRC text, or null when it carries no stamped line. */
export function parseLrc(text: unknown): StructuredLyricsInput | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  let offsetMs = 0;
  const lines: Array<{ startMs: number; text: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const offset = OFFSET_TAG.exec(line);
    if (offset) {
      offsetMs = Number(offset[1]);
      continue;
    }
    const stamps: number[] = [];
    let rest = line;
    for (let m = LEAD_STAMP.exec(rest); m; m = LEAD_STAMP.exec(rest)) {
      stamps.push(stampMs(m));
      rest = rest.slice(m[0].length);
    }
    // Metadata tags and unstamped text both land here.
    if (!stamps.length) continue;
    const words = rest.replace(WORD_STAMP, '').replace(/\s+/g, ' ').trim();
    for (const startMs of stamps) lines.push({ startMs, text: words });
  }
  if (!lines.length) return null;
  // Sorted, because a repeated chorus stamps one line at several points, and
  // stable, so two lines at the same instant keep the file's order.
  const shifted = lines
    .map((l) => ({ startMs: Math.max(0, l.startMs - offsetMs), text: l.text }))
    .sort((a, b) => a.startMs - b.startMs);
  return { synced: true, lines: shifted };
}

/** Untimed lyrics from plain text, or null when there is none. */
export function plainLyrics(text: unknown): StructuredLyricsInput | null {
  if (typeof text !== 'string') return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // NaN is how the music server's parse marks an untimed line.
    .map((l) => ({ startMs: Number.NaN, text: l }));
  return lines.length ? { synced: false, lines } : null;
}
