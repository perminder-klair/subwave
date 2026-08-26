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

// Anything holding a DERIVED copy of the zone subscribes here. Today that is
// the per-skill cron tasks, which bake the zone into node-cron's { timezone }
// option at registration and would otherwise keep firing on the old zone until
// an unrelated skill edit re-registered them.
//
// A subscriber rather than a call in POST /settings because settings.update()
// is not the only writer — routes/onboarding.ts patches `timezone` too, and a
// backup restore reaches update() directly. Putting the rule at the ONE place
// the zone actually changes is what keeps it from having to be remembered at
// each new writer. This module still imports nothing from the rest of the app,
// so no cycle: subscribers register themselves.
type TimezoneListener = (tz: string) => void;
const zoneListeners = new Set<TimezoneListener>();

export function onStationTimezoneChange(fn: TimezoneListener): void {
  zoneListeners.add(fn);
}

export function setStationTimezone(tz: string) {
  const next = typeof tz === 'string' && isValidTimezone(tz.trim()) ? tz.trim() : '';
  // Fires on a real change only. settings.load() and every successful update()
  // push the zone in whether or not it moved, and re-registering a station's
  // crons on every unrelated settings save is churn, not correctness.
  if (next === stationZone) return;
  stationZone = next;
  for (const fn of zoneListeners) {
    // One bad subscriber must not leave the zone half-applied for the others.
    try { fn(getStationTimezone()); } catch { /* subscriber's problem */ }
  }
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

// --- clock display + spoken forms (pure, pinned by scripts/clock-phrase.test.ts) ---
// The DJ prompt layer speaks whatever clock shape it is shown (issue: DJs
// saying "thirteen oh five" with the station set to AM/PM), so the prompt
// clock must be rendered here in the operator's chosen style rather than
// letting the model convert 24-hour digits itself.

// "13:05" (24h) or "1:05 pm" (12h). hour12 mirrors settings.locale === 'en-US'.
export function clockDisplay(hour: number, minute: number, hour12: boolean) {
  const mm = String(minute).padStart(2, '0');
  if (!hour12) return `${String(hour).padStart(2, '0')}:${mm}`;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${mm} ${hour < 12 ? 'am' : 'pm'}`;
}

const HOUR_WORDS = [
  'twelve', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
];

// The hour as a radio DJ would say it: "midnight", "noon", "one in the
// morning", "two in the afternoon", "eleven at night". Computed in code so
// the hourly time check never asks the model to convert 24-hour digits —
// small models get midnight wrong ("00:03" spoken as "one in the morning").
export function spokenHourPhrase(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return `${HOUR_WORDS[h % 12]} ${spokenDaypartPhrase(h)}`;
}

// The part of the day alone, in the shape spokenHourPhrase appends to the
// hour: "in the morning", "in the afternoon", "in the evening", "at night".
// This is what a station ident gets to say about the clock. An ident is
// written at the cron tick and airs after LLM + TTS + queue latency, so an
// hour is already too precise: told "the time of day, never the minutes" at
// 15:49, the model announced "three in the afternoon" — an hour that was
// eleven minutes from being wrong. The daypart is the only reading that
// survives that latency, so it is computed here and handed to the prompt
// rather than left for the model to truncate the clock into.
export function spokenDaypartPhrase(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  if (h < 12) return 'in the morning';
  if (h < 18) return 'in the afternoon';
  if (h < 22) return 'in the evening';
  return 'at night';
}

// The time as a radio DJ would round it — minute-aware, deliberately coarse
// (radio rounds, it doesn't read a watch). The hourly check normally rides the
// :00 cron where "just gone six" is honest, but manual /dj/segment triggers
// and voice-queue holds can land it anywhere in the hour, and the hour-only
// phrase said "just gone six" at 6:31 (#1282). Past :40 the phrase leans on
// the NEXT hour ("quarter to seven") — spokenHourPhrase normalises h+1 at the
// day edge, so 23:50 reads "coming up on midnight".
export function spokenTimePhrase(hour: number, minute: number) {
  const h = ((hour % 24) + 24) % 24;
  const m = ((Math.trunc(minute) % 60) + 60) % 60;
  if (m <= 4) return `just gone ${spokenHourPhrase(h)}`;
  if (m <= 14) return `just after ${spokenHourPhrase(h)}`;
  if (m <= 24) return `quarter past ${spokenHourPhrase(h)}`;
  if (m <= 39) return `half past ${spokenHourPhrase(h)}`;
  if (m <= 49) return `quarter to ${spokenHourPhrase(h + 1)}`;
  return `coming up on ${spokenHourPhrase(h + 1)}`;
}
