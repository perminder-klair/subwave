// The schedule in the listener's own clock. The grid is keyed by station day
// and station hour (the controller resolves the active show from that wall
// clock, #418), so the drawer still picks rows and the "now" highlight in
// station hours. Only the labels change: each station hour is turned into the
// instant it next falls on, then formatted in whichever zone the listener chose
// in the Appearance menu (lib/clockZone.ts).
//
// A zone a whole number of hours away keeps the ":00"; one like India's +5:30
// from London reads "14:30". A slot that lands on another day there carries
// that day ("SUN 20:30"), since the day tabs stay station days.

import { fmtClockMinute, normalizeStationLocale, zonedDayHour, type StationLocale } from './format';

const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MINUTE = 60_000;

/** Minutes since midnight on the wall clock in `tz` (the browser's when null). */
function zonedMinuteOfDay(date: Date, tz: string | null): number {
  if (!tz) return date.getHours() * 60 + date.getMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return (get('hour') % 24) * 60 + get('minute');
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

/** The instant station hour `hour` falls on, `dayOffset` station days after
 *  `now`'s. `hour` may be 24 (a block's end at midnight). Corrected once against
 *  the station's own wall clock, so a DST change in between still lands on the
 *  hour. */
export function stationHourInstant(
  now: Date,
  stationTz: string | null,
  dayOffset: number,
  hour: number,
): Date {
  const nowMinute = Math.floor(now.getTime() / MINUTE) * MINUTE;
  const sinceMidnight = zonedMinuteOfDay(now, stationTz);
  const wanted = dayOffset * 1440 + hour * 60;
  const guess = nowMinute - sinceMidnight * MINUTE + wanted * MINUTE;
  // How far the guess's station wall clock sits from the wanted one, folded
  // into ±12 h so a guess just past midnight doesn't read as a day out.
  let drift = (zonedMinuteOfDay(new Date(guess), stationTz) - (wanted % 1440)) % 1440;
  if (drift > 720) drift -= 1440;
  if (drift < -720) drift += 1440;
  return new Date(guess - drift * MINUTE);
}

/** Station days from `today` forward to `viewDay`: the next time it comes round. */
export function dayOffsetFor(viewDay: number, today: number): number {
  return (((viewDay - today) % 7) + 7) % 7;
}

/** One time label in the listener's zone, with the day when it is not the
 *  station day the row sits under. */
export function shownHour(
  now: Date,
  stationTz: string | null,
  shownTz: string | null,
  viewDay: number,
  today: number,
  hour: number,
  locale: StationLocale | null | undefined,
  edge: 'start' | 'end' = 'start',
): string {
  const at = stationHourInstant(now, stationTz, dayOffsetFor(viewDay, today), hour);
  const time = fmtClockMinute(at, shownTz, normalizeStationLocale(locale));
  // An end is dated by its last minute, so a block ending at midnight there
  // isn't tagged with the day it never reaches.
  const dated = edge === 'end' ? new Date(at.getTime() - MINUTE) : at;
  const shownDay = zonedDayHour(dated, shownTz).dow;
  return shownDay === viewDay ? time : `${DAY_LABELS[shownDay]} ${time}`;
}
