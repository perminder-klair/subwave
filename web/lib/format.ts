export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '–:––';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export type StationLocale = 'en-GB' | 'en-US';

const DEFAULT_STATION_LOCALE: StationLocale = 'en-GB';

export function normalizeStationLocale(locale: unknown): StationLocale {
  return locale === 'en-US' ? 'en-US' : DEFAULT_STATION_LOCALE;
}

function stationClockOptions(locale: StationLocale): Intl.DateTimeFormatOptions {
  return locale === 'en-US' ? { hour12: true } : { hour12: false };
}

// Rendered in the STATION's zone. The DJ speaks the time in the configured
// station timezone, so log/booth stamps must match or a viewer in another
// timezone sees stamps that disagree with what the DJ just said (issue #418).
// `tz` is the IANA zone from /now-playing | /state | /debug, falling back to
// the browser's local zone. Returns '' for a missing timestamp.
export function fmtClock(
  t: string | number | null | undefined,
  tz?: string | null,
  locale?: StationLocale | null,
): string {
  if (t == null) return '';
  const stationLocale = normalizeStationLocale(locale);
  try {
    return new Date(t).toLocaleTimeString(stationLocale, {
      ...stationClockOptions(stationLocale),
      ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    return String(t);
  }
}

export function fmtClockMinute(
  t: string | number | Date,
  tz?: string | null,
  locale?: StationLocale | null,
): string {
  const stationLocale = normalizeStationLocale(locale);
  try {
    return new Date(t).toLocaleTimeString(stationLocale, {
      hour: '2-digit',
      minute: '2-digit',
      ...stationClockOptions(stationLocale),
      ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    return '';
  }
}

// Full local station date + time for the admin header clock, e.g.
// "Thursday 24 September 2026   04:37:45". The weekday/month words are
// always English regardless of station locale (the rest of this admin is
// English text around a live English-language date), but the clock follows
// the station's own 12h/24h convention via fmtClock — same station
// zone/locale as elsewhere, so the header never disagrees with what the DJ is
// actually saying on air (issue #418).
export function fmtStationDateTime(
  t: string | number | Date,
  tz?: string | null,
  locale?: StationLocale | null,
): string {
  try {
    const date = new Date(t);
    const parts = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      ...(tz ? { timeZone: tz } : {}),
    }).formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    // 'en-GB' already gives "Thursday"/"September" — leading capital, rest
    // lowercase — so no extra casing pass is needed.
    const datePart = `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`;
    // Three non-breaking spaces, not three plain ones — HTML collapses
    // consecutive plain spaces to one, so a literal "   " here would render
    // identically to " ".   doesn't collapse, which is what triples the
    // visual gap between the year and the clock without touching the single
    // spaces inside the date itself.
    return `${datePart}   ${
      // fmtClock, not fmtClockMinute: toLocaleTimeString with no explicit
      // hour/minute/second option defaults to showing all three, which is
      // what puts the ticking seconds digit ("04:37:45") on this display.
      // fmtClock's signature takes string | number, not Date — .getTime()
      // instead of handing it `date` directly.
      fmtClock(date.getTime(), tz, locale)
    }`;
  } catch {
    return '';
  }
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Day-of-week (0=Sun) and hour (0-23) for `date` on the wall clock in `tz`.
// Mirrors the controller's zonedParts so the schedule grid's "now" marker lands
// on the same cell the controller resolves the active show from; otherwise the
// highlight follows the operator's browser zone, not the station's (#418).
export function zonedDayHour(date: Date, tz?: string | null): { dow: number; hour: number } {
  if (!tz) return { dow: date.getDay(), hour: date.getHours() };
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(date);
    const out: Record<string, string> = {};
    for (const p of parts) out[p.type] = p.value;
    // en-GB with hour12:false can render midnight as "24".
    return { dow: DOW[out.weekday ?? ''] ?? date.getDay(), hour: Number(out.hour) % 24 };
  } catch {
    return { dow: date.getDay(), hour: date.getHours() };
  }
}

export function relTime(t: string | number | Date): string {
  const diff = (Date.now() - new Date(t).getTime()) / 1000;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function fmtSize(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
