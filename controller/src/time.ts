// Station-zone date math — the single home for "what's the wall clock at the
// station right now?". The operator can pick an IANA zone in admin →
// Settings → Station (settings.timezone); empty means Auto, i.e. the
// container's own TZ. Everything with local-time *semantics* (time-of-day
// moods, schedule slots, festival dates, the hourly check) goes through
// zonedParts(); timestamps and durations keep using Date directly.
//
// Deliberately imports nothing from the rest of the app so settings.ts can
// import it without a cycle — settings pushes the configured zone in via
// setStationTimezone() on load and on every successful update.

let stationZone = '';

// Formatter instances are not cheap and zonedParts runs several times a
// minute — cache one per zone.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hour12: false,
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimezone(tz: string) {
  // try/catch rather than Intl.supportedValuesOf so aliases (Europe/Kiev,
  // US/Pacific, …) validate too — the formatter accepts anything ICU knows.
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function setStationTimezone(tz: string) {
  stationZone = typeof tz === 'string' && isValidTimezone(tz.trim()) ? tz.trim() : '';
}

// The *effective* zone — configured, or whatever the process resolved to.
export function getStationTimezone() {
  return stationZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// Sunday-first, matching Date.getDay() — the schedule grid is stored that way.
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export type ZonedParts = {
  year: number;
  month: number; // 1-12, matching getMonth() + 1 at the call sites
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  dow: number; // 0-6, Sunday = 0
};

export function zonedParts(date = new Date()): ZonedParts {
  const parts = formatterFor(getStationTimezone()).formatToParts(date);
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    // en-GB with hour12:false can render midnight as "24" — normalise.
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    dow: DOW[out.weekday] ?? 0,
  };
}

export function zonedISODate(date = new Date()) {
  const { year, month, day } = zonedParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
