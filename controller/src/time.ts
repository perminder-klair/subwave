// Station-zone date math. settings.timezone picks an IANA zone; empty = the
// container's own TZ. Everything with local-time SEMANTICS (moods, schedule
// slots, festival dates, the hourly check, the station-hour session roll) goes
// through zonedParts(); timestamps and durations keep using Date.
//
// Imports nothing from the rest of the app so settings.ts can import it without
// a cycle — settings pushes the zone in via setStationTimezone().

let stationZone = '';

// Formatters are not cheap and zonedParts runs several times a minute.
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
  // US/Pacific) validate too.
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Anything holding a DERIVED copy of the zone subscribes here — today the
// per-skill crons, which bake it into node-cron's { timezone } at registration.
// A subscription rather than a call in POST /settings because update() is not
// the only writer (onboarding patches `timezone`, backup restore calls update()
// directly). Subscribers register themselves, so no import cycle.
type TimezoneListener = (tz: string) => void;
const zoneListeners = new Set<TimezoneListener>();

export function onStationTimezoneChange(fn: TimezoneListener): void {
  zoneListeners.add(fn);
}

export function setStationTimezone(tz: string) {
  const next = typeof tz === 'string' && isValidTimezone(tz.trim()) ? tz.trim() : '';
  const before = getStationTimezone();
  stationZone = next;
  // Fires on a change of the EFFECTIVE zone only: load() and every update()
  // push the zone in whether or not it moved, and naming the zone the process
  // already runs in ('' to the host's own zone) moves no clock. Re-registering
  // crons each save is churn.
  if (getStationTimezone() === before) return;
  for (const fn of zoneListeners) {
    // One bad subscriber must not leave the zone half-applied for the others.
    try { fn(getStationTimezone()); } catch { /* subscriber's problem */ }
  }
}

// The effective zone: configured, else whatever the process resolved to.
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

// The talk tick's session roll runs on the STATION clock (#2234, #2254). The
// show grid changes when the station hour does, and a station zone a
// fractional number of hours from the process's (IST or Nepal on a London or
// UTC host, or the reverse) puts that moment at process :30, :15 or :45.
//
// The tick rolls when this key differs from the one its previous tick saw, not
// on station minute 0. A station hour can open without a :00 ever reaching a
// tick: a timezone saved mid-hour, a zone whose DST shift is 30 or 45 minutes
// (Lord Howe's spring-forward opens hour 2 at 02:30, Chatham's opens hour 3 at
// 03:45 and its fall-back repeats 02:45-02:59), or a tick that ran late. A
// fall-back repeats its key, so the tick also compares the zone's UTC offset
// (stationUtcOffsetMinutes): the repeated hour rolls again, a no-op roll that
// replaces the first one, so its hourly row cannot re-air the first pass's
// show welcome.
//
// The key is also how the hourly row finds the roll that opened its hour. Zone
// offsets are whole quarter hours, so process :00 lands on station :00, :15,
// :30 or :45, and the row's ten-minute window, still on process minutes,
// closes by station :54, inside the station hour that rolled. Pinned by
// scripts/station-hour-roll.test.ts.
export function stationHourKey(date = new Date()) {
  const { year, month, day, hour } = zonedParts(date);
  return `${year}-${month}-${day}-${hour}`;
}

// The station zone's offset from UTC in minutes at `date` (+330 for IST). It
// changes at a DST transition, which is how the tick tells a fall-back's
// repeated hour from the hour it repeats.
export function stationUtcOffsetMinutes(date = new Date()) {
  const { year, month, day, hour, minute } = zonedParts(date);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  return Math.round((wall - (date.getTime() - (date.getTime() % 60_000))) / 60_000);
}

// The process-clock minute the station's :00 lands on right now: 0 for a
// whole-hour offset, else 15, 30 or 45. For crons, which fire on process
// minutes, to keep off the roll. It moves with a zone change, and with a DST
// change only in a zone whose shift is not a whole hour.
export function stationHourStartProcessMinute(date = new Date()) {
  return (date.getMinutes() - zonedParts(date).minute + 60) % 60;
}

// Clock display + spoken forms (pure, pinned by scripts/clock-phrase.test.ts).
// The model speaks whatever clock shape it is shown, so the prompt clock is
// rendered here in the operator's style rather than left for it to convert.

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

// The hour as a DJ says it ("midnight", "two in the afternoon"). In code because
// small models convert 24-hour digits wrong, especially around midnight.
export function spokenHourPhrase(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return `${HOUR_WORDS[h % 12]} ${spokenDaypartPhrase(h)}`;
}

// The part of the day alone, in the shape spokenHourPhrase appends to the hour.
// This is all a station ident may say about the clock: an ident is written at the
// cron tick and airs after LLM + TTS + queue latency, so even the hour is too
// precise to survive.
export function spokenDaypartPhrase(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  if (h < 12) return 'in the morning';
  if (h < 18) return 'in the afternoon';
  if (h < 22) return 'in the evening';
  return 'at night';
}

// The minute bands a DJ rounds the clock into (#1282 — a manual trigger can land
// the hourly check anywhere in the hour). Past :40 a band leans on the NEXT hour
// (`ahead`); spokenHourPhrase normalises h+1 at the day edge, so 23:50 reads
// "coming up on midnight".
//
// Each band carries several interchangeable wordings of the ONE rounded time
// (#1602). A new form must read true at every minute in its band INCLUDING the
// minute it opens on: never sharpen "half past" into a count of minutes, never
// claim a boundary has been passed when the band opens on it, never drop the
// qualifier and leave a bare hour. The refusal notes below are what a candidate
// form gets checked against; stream.bufferSeconds is not an argument for keeping
// one, since it is an operator dial. The hour word is always spokenHourPhrase's,
// never re-derived, or the day-edge normalisation goes with it. `forms[0]` is
// what spokenTimePhrase returns.
const TIME_BANDS: readonly {
  upTo: number;
  ahead: boolean;
  forms: readonly ((hour: string) => string)[];
}[] = [
  // Refuses "a minute or so past": the band opens at :00, where the cron fires.
  { upTo: 4, ahead: false, forms: [
    (h) => `just gone ${h}`,
    (h) => `just past ${h}`,
    (h) => `just turned ${h}`,
  ] },
  { upTo: 14, ahead: false, forms: [
    (h) => `just after ${h}`,
    (h) => `a few minutes past ${h}`,
    (h) => `a little after ${h}`,
  ] },
  // Refuses "gone quarter past": the band opens exactly ON :15. "around" is the
  // safe direction — it widens the claim rather than sharpening it.
  { upTo: 24, ahead: false, forms: [
    (h) => `quarter past ${h}`,
    (h) => `a quarter past ${h}`,
    (h) => `around quarter past ${h}`,
  ] },
  // Refuses "gone half past": the band opens at :25, on the near side of :30.
  { upTo: 39, ahead: false, forms: [
    (h) => `half past ${h}`,
    (h) => `around half past ${h}`,
    (h) => `half past ${h}, give or take`,
  ] },
  { upTo: 49, ahead: true, forms: [
    (h) => `quarter to ${h}`,
    (h) => `a quarter to ${h}`,
    (h) => `around quarter to ${h}`,
  ] },
  { upTo: 59, ahead: true, forms: [
    (h) => `coming up on ${h}`,
    (h) => `coming up to ${h}`,
    (h) => `nearly ${h}`,
    (h) => `almost ${h}`,
  ] },
];

// Every equivalent wording of the rounded time, canonical form first. The CALLER
// picks one and the prompt dictates that one string — the model is never handed
// the set, since a time clause offering options is the latitude #1282 removed.
export function spokenTimePhrases(hour: number, minute: number): string[] {
  const h = ((hour % 24) + 24) % 24;
  const m = ((Math.trunc(minute) % 60) + 60) % 60;
  const band = TIME_BANDS.find((b) => m <= b.upTo) ?? TIME_BANDS[TIME_BANDS.length - 1];
  const spokenHour = spokenHourPhrase(band.ahead ? h + 1 : h);
  return band.forms.map((f) => f(spokenHour));
}

// The rounded time for callers that want one string with no rotation state.
export function spokenTimePhrase(hour: number, minute: number) {
  return spokenTimePhrases(hour, minute)[0];
}
