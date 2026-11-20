// The Festivals panel's "now" badge, "up next" countdown and date label.
// Whether a festival is on is the controller's own rule (festivalActiveOn in
// the mirrored settings schema), so the badge cannot disagree with
// getFestivalContext about which days a festival covers. The panel judges the
// browser's date, not the station's timezone, as it always has.

import { festivalActiveOn, festivalEnd } from './schemas.generated';

export type FestivalDates = {
  month: number;
  day: number;
  windowDays?: number;
  endMonth?: unknown;
  endDay?: unknown;
};

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `active`: on today. `until`: whole days to the next start date (0 = today). */
export function festivalTiming(f: FestivalDates, now: Date): { active: boolean; until: number } {
  const dayMs = 86400000;
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffs = [-1, 0, 1].map(dy =>
    Math.round((new Date(now.getFullYear() + dy, f.month - 1, f.day).getTime() - t0) / dayMs),
  );
  return {
    active: festivalActiveOn(f, {
      year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(),
    }),
    until: Math.min(...diffs.filter(d => d >= 0)),
  };
}

/** The row's date note: "28 Nov – 2 Jan" for a range, "±3d" for a window, else null. */
export function festivalSpanLabel(f: FestivalDates): string | null {
  const end = festivalEnd(f);
  if (end) {
    return `${f.day} ${SHORT_MONTHS[f.month - 1]} – ${end.day} ${SHORT_MONTHS[end.month - 1]}`;
  }
  return f.windowDays ? `±${f.windowDays}d` : null;
}
