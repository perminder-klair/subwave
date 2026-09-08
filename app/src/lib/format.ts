// SOURCE OF TRUTH: web/web/lib/format.ts — kept in sync (pure functions).

export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '–:––';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Station display locale (#475): UK is 24-hour, US is AM/PM. */
export type StationLocale = 'en-GB' | 'en-US';

export const DEFAULT_STATION_LOCALE: StationLocale = 'en-GB';

export function normalizeStationLocale(locale: unknown): StationLocale {
  return locale === 'en-US' ? 'en-US' : DEFAULT_STATION_LOCALE;
}

function stationClockOptions(locale: StationLocale): Intl.DateTimeFormatOptions {
  return locale === 'en-US' ? { hour12: true } : { hour12: false };
}

// Time-of-day for an on-air event in the station's zone, so stamps agree with
// what the DJ speaks (#418). `tz` is the IANA zone from /now-playing, falling
// back to the device zone; `locale` picks 24h vs AM/PM (#475). '' when the
// timestamp is missing.
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

export function relTime(t: string | number | Date): string {
  const diff = (Date.now() - new Date(t).getTime()) / 1000;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
