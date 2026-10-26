// The dust cover as a screen. In focus mode the column of facts beside the
// drawing folds away and the open lid's panel carries the now-playing card
// instead: laid out here in the panel's own flat units (LID_SHEET carries
// them onto the glass), so the scene only paints the rows this decides.
// Pure data, no React.

import { round2 } from '@/components/iso/geometry';

/** What the screen shows: the column's facts, already worded by the skin. */
export interface LidScreenInfo {
  eyebrow: string;
  /** The DJ is on the mic: the eyebrow carries a lit dot. */
  onAir: boolean;
  title: string;
  artist: string;
  /** Album · year, or empty. */
  detail: string;
  elapsed: string;
  duration: string;
  /** 0..1 through the track, null when the duration is unknown. */
  ratio: number | null;
  /** The bottom row: what's cued next, or the DJ's words while they talk. */
  foot: { kind: 'next' | 'quote'; text: string } | null;
}

/** The window the card is laid out in, in sheet units: inside the strips the
 *  cover's walls hide (LID_SHEET.clear), with a margin, and clear of the
 *  hinge knuckles along the bottom edge. */
export const SCREEN = { x: 12, y: 20, w: 180, h: 102 } as const;

/** Type sizes in sheet units, and each mono row's tracking in ems. */
export const ROW = {
  eyebrow: { size: 6.5, tracking: 0.2 },
  artist: { size: 8.5, tracking: 0.14 },
  detail: { size: 6.5, tracking: 0.12 },
  time: { size: 6.5, tracking: 0.06 },
  next: { size: 6.5, tracking: 0.08 },
  quote: { size: 7.5, tracking: 0 },
} as const;

/** The title's sizes, largest first: one big line when it fits, two smaller
 *  lines when it doesn't, and smaller still, cut short, past that. */
const TITLE_FITS = [
  { size: 24, lines: 1 },
  { size: 18, lines: 2 },
  { size: 14, lines: 2 },
] as const;

/** Progress segments in the bar. */
export const SEGMENTS = 36;

// Advance per character in ems. An estimate that leans wide: the display
// face's italic runs about half an em, the mono 0.6 plus its tracking. The
// scene measures each row once drawn and squeezes any that still overflow.
const DISPLAY_EM = 0.52;
const MONO_EM = 0.6;

const charsAt = (size: number, em: number) => Math.max(1, Math.floor(SCREEN.w / (size * em)));
const monoChars = (row: { size: number; tracking: number }) => charsAt(row.size, MONO_EM + row.tracking);

/** Cut a line to `max` characters, ending it with an ellipsis if it ran over. */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Word-wrap into lines of at most `maxChars`. A word wider than a line
 *  breaks where the line does; past `maxLines` the rest is cut short into
 *  the last line. */
export function wrapLines(text: string, maxChars: number, maxLines = Infinity): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    const joined = line ? `${line} ${word}` : word;
    if (joined.length <= maxChars) { line = joined; continue; }
    if (line) lines.push(line);
    let rest = word;
    while (rest.length > maxChars) { lines.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars); }
    line = rest;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = clip(lines.slice(maxLines - 1).join(' '), maxChars);
  return kept;
}

/** The largest title size whose wrap fits its line budget. */
export function titleFit(title: string): { size: number; lines: string[] } {
  for (const fit of TITLE_FITS.slice(0, -1)) {
    const lines = wrapLines(title, charsAt(fit.size, DISPLAY_EM));
    if (lines.length <= fit.lines) return { size: fit.size, lines };
  }
  const last = TITLE_FITS[TITLE_FITS.length - 1]!;
  return { size: last.size, lines: wrapLines(title, charsAt(last.size, DISPLAY_EM), last.lines) };
}

export interface ScreenRow { text: string; y: number }

export interface ScreenLayout {
  eyebrow: ScreenRow;
  title: { size: number; rows: ScreenRow[] };
  artist: ScreenRow | null;
  detail: ScreenRow | null;
  /** The progress segments' box, between the elapsed and length readings. */
  bar: { x: number; y: number; w: number; h: number };
  /** Baseline of the row the elapsed and length readings flank the bar on. */
  timeY: number;
  foot: (ScreenRow & { kind: 'next' | 'quote' }) | null;
}

/** Baselines for every row: the eyebrow, title, artist and album hang from
 *  the top of the window, the progress, times and foot stand on its bottom,
 *  and the title's size is what keeps the two apart. */
export function screenLayout(info: LidScreenInfo): ScreenLayout {
  const { y, h } = SCREEN;
  const bottom = y + h;

  const eyebrowY = y + ROW.eyebrow.size;
  const fit = titleFit(info.title);
  // First baseline sits an ascent below the eyebrow; the rest a line apart.
  const titleRows = fit.lines.map((text, i) => ({
    text,
    y: round2(eyebrowY + 4 + fit.size * (0.9 + i * 1.02)),
  }));
  const titleEnd = titleRows[titleRows.length - 1]?.y ?? eyebrowY;
  const artistY = round2(titleEnd + 6 + ROW.artist.size);
  const artist = info.artist
    ? { text: clip(info.artist.toUpperCase(), monoChars(ROW.artist)), y: artistY }
    : null;
  const detail = info.detail
    ? { text: clip(info.detail.toUpperCase(), monoChars(ROW.detail)), y: round2((artist ? artistY : titleEnd) + 4 + ROW.detail.size) }
    : null;

  const foot = info.foot
    ? {
        kind: info.foot.kind,
        y: bottom - 1,
        text: info.foot.kind === 'quote'
          ? clip(`“${info.foot.text}”`, charsAt(ROW.quote.size, DISPLAY_EM))
          // "NEXT" prints ahead of it, so it gets the line less those 6.
          : clip(info.foot.text, monoChars(ROW.next) - 6),
      }
    : null;
  const timeY = foot ? foot.y - 12 : bottom - 1;
  // The readings flank the bar on one row, and the bar takes what the longer
  // of the two leaves. Stacked, the bar sat between two dim rows a few units
  // either side, and on a dark theme the three ran together.
  const reading = Math.max(info.elapsed.length, info.duration.length) * ROW.time.size * (MONO_EM + ROW.time.tracking);
  const inset = round2(reading + 4);
  // Centred on the readings' capitals.
  const bar = { x: SCREEN.x + inset, y: round2(timeY - 4.3), w: round2(SCREEN.w - inset * 2), h: 4 };

  return {
    eyebrow: { text: clip(info.eyebrow.toUpperCase(), monoChars(ROW.eyebrow) - (info.onAir ? 2 : 0)), y: eyebrowY },
    title: { size: fit.size, rows: titleRows },
    artist,
    detail,
    bar,
    timeY,
    foot,
  };
}
