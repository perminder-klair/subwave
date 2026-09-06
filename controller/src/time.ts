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

// The minute bands a radio DJ rounds the clock into — deliberately coarse
// (radio rounds, it doesn't read a watch). The hourly check normally rides the
// :00 cron where "just gone six" is honest, but manual /dj/segment triggers
// and voice-queue holds can land it anywhere in the hour, and the hour-only
// phrase said "just gone six" at 6:31 (#1282). Past :40 a band leans on the
// NEXT hour (`ahead`) — spokenHourPhrase normalises h+1 at the day edge, so
// 23:50 reads "coming up on midnight".
//
// Each band carries SEVERAL wordings of the one rounded time (#1602): the
// single fixed string made every hour of every day open with the identical
// five words, because the check almost always fires in the first band and the
// prompt is told to say it verbatim. The wordings vary, the reading does not —
// every form in a band must be interchangeable at every minute IN that band,
// INCLUDING the minute it opens on. That last clause is the one that is easy
// to lose: a form is measured against the band's widest minute AND its first,
// so nothing here may sharpen "half past" into a count of minutes (wrong on
// the near side of :30), nothing may claim a band's boundary has been passed
// when the band opens exactly on it, and nothing may drop the qualifier and
// leave a bare hour. Every band with an obvious near-miss form carries a note
// naming the form it REFUSES and why, because the refusals are the part of
// the table a new form gets checked against. The broadcast buffer does not
// count as an argument for keeping a form: a listener does hear this
// stream.bufferSeconds late, but that is a number defined in another module
// and an operator dial, so a form whose honesty depends on it stops being
// honest the moment the dial moves. The hour word is always spokenHourPhrase's — never
// re-derived here, or the day-edge normalisation goes with it. `forms[0]` is
// the wording that shipped before the variants, and spokenTimePhrase still
// returns it.
const TIME_BANDS: readonly {
  upTo: number;
  ahead: boolean;
  forms: readonly ((hour: string) => string)[];
}[] = [
  // No "a minute or so past" here: the band opens at :00, the minute this row's
  // cron fires on almost every time, and nothing is a minute past the hour at
  // the hour.
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
  // No "gone quarter past" here, for the reason the :25-:39 band refuses "gone
  // half past": the band opens exactly ON quarter past, so at :15 nothing has
  // gone anywhere. "around" is the safe direction — it widens the claim rather
  // than sharpening it, and reads true across the whole :15-:24 span.
  { upTo: 24, ahead: false, forms: [
    (h) => `quarter past ${h}`,
    (h) => `a quarter past ${h}`,
    (h) => `around quarter past ${h}`,
  ] },
  // No "gone half past" here: the band opens at :25, so half of it is on the
  // near side of the half hour. This is the refusal the other two are modelled
  // on.
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

// Every equivalent wording of the rounded time, canonical form first. The
// caller picks one (llm/internal/prompts/context.ts's no-repeat picker, the
// same rule that keeps narrative angles from settling) and the prompt still
// dictates that ONE string — the model is never handed the set to choose from,
// because a time clause offering options is the latitude #1282 removed.
export function spokenTimePhrases(hour: number, minute: number): string[] {
  const h = ((hour % 24) + 24) % 24;
  const m = ((Math.trunc(minute) % 60) + 60) % 60;
  const band = TIME_BANDS.find((b) => m <= b.upTo) ?? TIME_BANDS[TIME_BANDS.length - 1];
  const spokenHour = spokenHourPhrase(band.ahead ? h + 1 : h);
  return band.forms.map((f) => f(spokenHour));
}

// The rounded time in the wording that predates the variants — every caller
// that wants one string with no rotation state behind it.
export function spokenTimePhrase(hour: number, minute: number) {
  return spokenTimePhrases(hour, minute)[0];
}
