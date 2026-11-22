// Where the needle sits on the Stats page's tuner dial (admin/stats/SectionDial).
// A position counts stations along the scale: 2.5 is halfway through the third
// section. The section under the reading line, a height in the viewport, is the
// one tuned in.
//
// The line rests just below the dial, but the page's last sections can never
// scroll that high. So over the final screenful of scroll it sweeps down to the
// bottom of the viewport, or the needle would stop short of them.

export interface DialPage {
  tops: number[]; // each section's top edge, top to bottom, in viewport pixels
  end: number; // where the last section ends, in viewport pixels
  rest: number; // the reading line's resting height, in viewport pixels
  viewport: number; // the viewport's height
  scrolled: number; // pixels scrolled from the top of the page
  remaining: number; // pixels left to scroll
}

type LineInputs = Pick<DialPage, 'rest' | 'viewport' | 'scrolled' | 'remaining'>;

export function readingLine({ rest, viewport, scrolled, remaining }: LineInputs): number {
  const sweep = Math.min(viewport, scrolled + remaining);
  const through = sweep > 0 ? Math.max(0, 1 - remaining / sweep) : 0;
  return rest + (viewport - rest) * through;
}

export function dialPosition(page: DialPage): number {
  const { tops, end } = page;
  const line = readingLine(page);
  const at = tops.filter(top => top <= line).length - 1;
  if (at < 0) return 0;
  const top = tops[at]!;
  const span = (tops[at + 1] ?? end) - top;
  return at + (span > 0 ? Math.min(1, (line - top) / span) : 0);
}

// The far end of the scale still reads as the last station.
export const stationAt = (position: number, count: number) =>
  Math.min(Math.floor(position), count - 1);
