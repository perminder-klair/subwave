// Context engine — what should the DJ feel like right now?
// Used by the autonomous scheduler to pick mood-appropriate tracks.

import { config } from './config.js';
import { fetchWithTimeout } from './util/fetch-timeout.js';
import { resolveActiveShow, resolveOnAirLocation, get as getSettings, moodScheduleFor, weatherMoodFor } from './settings.js';
import * as session from './broadcast/session.js';
import { getListenerCount } from './broadcast/listeners.js';
import { zonedParts, zonedISODate, clockDisplay, spokenHourPhrase, spokenTimePhrases, spokenDaypartPhrase } from './time.js';

// Day-period → {vibe, show}. Vibe strings land in spoken-segment prompts, so
// keep them non-commute-flavoured; the period names drive pick energy, not talk.
// Each period's MOOD is operator-editable (settings.moodSchedule).
const PERIOD_TABLE: Array<{ from: number; to: number; period: string; vibe: string; show: string }> = [
  { from: 5, to: 9, period: 'early-morning', vibe: 'gentle waking', show: 'breakfast' },
  { from: 9, to: 12, period: 'morning', vibe: 'productive', show: 'morning' },
  { from: 12, to: 14, period: 'midday', vibe: 'lunch hour', show: 'midday' },
  { from: 14, to: 17, period: 'afternoon', vibe: 'sustained energy', show: 'afternoon' },
  { from: 17, to: 19, period: 'drive-time', vibe: 'end of the workday', show: 'drive-time' },
  { from: 19, to: 22, period: 'evening', vibe: 'wind down', show: 'evening' },
];

export function getTimeContext(date = new Date()) {
  const h = zonedParts(date).hour;
  const slot =
    PERIOD_TABLE.find((s) => h >= s.from && h < s.to) ??
    (h >= 22 || h < 1
      ? { period: 'late-evening', vibe: 'late hours', show: 'late' }
      : { period: 'after-hours', vibe: 'after hours', show: 'graveyard' });
  return { period: slot.period, mood: moodScheduleFor(slot.period), vibe: slot.vibe, show: slot.show };
}

// Festival calendar comes from persisted settings. settings.load() seeds
// FESTIVAL_DEFAULTS when the key is absent; an emptied list stays empty, so no
// fallback here.
const DAY_MS = 24 * 60 * 60 * 1000;

export function getFestivalContext(date = new Date()) {
  const { year: y, month: m, day: d } = zonedParts(date);
  const today = Date.UTC(y, m - 1, d);
  for (const f of getSettings().festivals ?? []) {
    const window = f.windowDays || 0;
    // Compare real dates so a window spans month/year boundaries; the adjacent
    // years cover one reaching across Dec 31 / Jan 1.
    for (const yy of [y - 1, y, y + 1]) {
      if (Math.abs(Date.UTC(yy, f.month - 1, f.day) - today) <= window * DAY_MS) {
        return { name: f.name, mood: f.mood, description: f.description || '' };
      }
    }
  }
  return null;
}

// Weather via Open-Meteo (no API key required)
let weatherCache: { data: any; fetchedAt: number; configKey: string } = {
  data: null,
  fetchedAt: 0,
  configKey: '',
};
const WEATHER_TTL_MS = 30 * 60 * 1000;

// Weather is settings-layer state: read the live settings cache, never a
// config.weather mirror — onboarding and backup restore call settings.update()
// directly and would leave a mirror stale until a restart.
function weatherConfig() {
  return getSettings().weather || config.weather;
}

function weatherConfigKey(weather: ReturnType<typeof weatherConfig>) {
  return [
    weather.lat,
    weather.lng,
    weather.units,
    weather.locationName,
    weather.onAirLocation,
  ].join('\u0000');
}

// Force the next getWeather() to re-fetch (location changed in /settings).
export function invalidateWeatherCache() {
  weatherCache = { data: null, fetchedAt: 0, configKey: '' };
}

// The place the readout is ATTRIBUTED to — the broad on-air location, not the
// precise point the forecast was fetched for; that is what keeps a public read
// from naming the operator's town. Fed the same live weather block as the
// forecast query so the two cannot drift.
function attributedLocation(weather = weatherConfig()) {
  return resolveOnAirLocation({ weather });
}

export async function getWeather() {
  const weather = weatherConfig();
  const configKey = weatherConfigKey(weather);
  if (
    weatherCache.data &&
    weatherCache.configKey === configKey &&
    Date.now() - weatherCache.fetchedAt < WEATHER_TTL_MS
  ) {
    return weatherCache.data;
  }
  const imperial = weather.units === 'imperial';
  const tempUnit = imperial ? 'F' : 'C';
  try {
    const unitParam = imperial ? '&temperature_unit=fahrenheit' : '';
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${weather.lat}&longitude=${weather.lng}&current=temperature_2m,weather_code,is_day${unitParam}`;
    const res = await fetchWithTimeout(url, { timeoutMs: 10_000 });
    const data = await res.json() as any;
    const code = data.current.weather_code;
    const condition = mapWeatherCode(code);
    const result = {
      condition,
      mood: weatherToMood(condition),
      temp: Math.round(data.current.temperature_2m),
      tempUnit,
      isDay: data.current.is_day === 1,
      location: attributedLocation(weather),
    };
    weatherCache = { data: result, fetchedAt: Date.now(), configKey };
    return result;
  } catch {
    return { condition: 'unknown', mood: null, temp: null, tempUnit, location: attributedLocation(weather) };
  }
}

function mapWeatherCode(code: number) {
  // WMO weather codes simplified
  if (code === 0) return 'clear';
  if (code <= 3) return 'cloudy';
  if (code >= 45 && code <= 48) return 'foggy';
  if (code >= 51 && code <= 67) return 'rainy';
  if (code >= 71 && code <= 77) return 'snowy';
  if (code >= 80 && code <= 99) return 'stormy';
  return 'cloudy';
}

// Operator-editable weather → mood map. '' (no steer) normalises to null so the
// dominantMood chain (festival > weather > time) falls through to the time mood.
function weatherToMood(condition) {
  return weatherMoodFor(condition) || null;
}

// Geocoding via Open-Meteo for the admin/onboarding location picker: place name
// → coordinates + IANA timezone. Cached per lowercased query for a day, with a
// soft entry cap.
export interface GeocodeResult {
  name: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
  lat: number;
  lng: number;
  timezone?: string;
  label: string;
}

const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const GEOCODE_CACHE_MAX = 200;
const geocodeCache = new Map<string, { results: GeocodeResult[]; fetchedAt: number }>();

export async function geocodePlace(query: string): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const key = q.toLowerCase();
  const hit = geocodeCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < GEOCODE_TTL_MS) {
    // Map iteration order is insertion order, so delete+set keeps the oldest
    // entry first for eviction.
    geocodeCache.delete(key);
    geocodeCache.set(key, hit);
    return hit.results;
  }

  const url =
    'https://geocoding-api.open-meteo.com/v1/search?name=' +
    encodeURIComponent(q) +
    '&count=6&language=en&format=json';
  // Bounded because GET /geocode is public and unauthenticated: a stalled
  // upstream would otherwise park a handler until undici's ~300s default.
  const res = await fetchWithTimeout(url, { timeoutMs: 10_000 });
  if (!res.ok) throw new Error(`geocoding upstream ${res.status}`);
  const data = (await res.json()) as { results?: any[] };
  const results: GeocodeResult[] = (data.results || []).map((r: any) => {
    const name = r.name as string;
    const admin1 = r.admin1 as string | undefined;
    const country = r.country as string | undefined;
    return {
      name,
      admin1,
      country,
      countryCode: r.country_code,
      lat: r.latitude,
      lng: r.longitude,
      timezone: r.timezone,
      label: [name, admin1, country].filter(Boolean).join(', '),
    };
  });

  geocodeCache.set(key, { results, fetchedAt: Date.now() });
  if (geocodeCache.size > GEOCODE_CACHE_MAX) {
    geocodeCache.delete(geocodeCache.keys().next().value!);
  }
  return results;
}

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];

// Meteorological seasons, hemisphere-aware: a negative lat shifts them six
// months so a southern station reads July as winter.
function seasonFor(month /* 1-12 */, lat = weatherConfig().lat) {
  const m = lat < 0 ? ((month + 5) % 12) + 1 : month;
  if (m === 12 || m <= 2) return 'winter';
  if (m <= 5) return 'spring';
  if (m <= 8) return 'summer';
  return 'autumn';
}

export function getDateContext(date = new Date()) {
  const { dow, month, day } = zonedParts(date);
  return {
    // Station-zone date, not UTC — toISOString() is a day off near midnight for
    // any offset zone.
    iso: zonedISODate(date),
    dayOfWeek: dow,
    dayLabel: DAY_LABELS[dow],
    monthLabel: MONTH_LABELS[month - 1],
    dayOfMonth: day,
    season: seasonFor(month),
  };
}

export function getClockContext(date = new Date()) {
  const { hour: h, minute: m, dow } = zonedParts(date);
  const minutesOfDay = h * 60 + m;
  // One band build per call: this runs on every listener's 5s /now-playing poll,
  // and `spokenTime` is by definition the band's first form (time.ts).
  const spokenTimeForms = spokenTimePhrases(h, m);
  return {
    hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    // The clock shape the model sees, so it follows the operator's locale
    // (en-US → "1:05 pm") rather than feeding 24-hour digits.
    display: clockDisplay(h, m, getSettings().locale === 'en-US'),
    // Deterministic spoken hour, so the model never converts digits itself.
    spokenHour: spokenHourPhrase(h),
    // Minute-aware variant for the hourly check — "just gone six" only near :00,
    // "half past six" mid-hour (#1282).
    spokenTime: spokenTimeForms[0],
    // Every equivalent wording of that rounded time (#1602); the hourly prompt
    // picks one per check. CONTROLLER-INTERNAL: prompt plumbing, not a station
    // fact — routes/public.ts strips it before /now-playing goes out, and
    // anything else of this kind added here belongs on that strip list.
    spokenTimeOptions: spokenTimeForms,
    // Daypart only, for the station ident — it airs minutes after it is written,
    // so it must not name the hour.
    spokenDaypart: spokenDaypartPhrase(h),
    isWeekend: dow === 0 || dow === 6,
    isLateNight: h < 5,
    isCommute: (minutesOfDay >= 450 && minutesOfDay < 570) ||  // 07:30-09:30
               (minutesOfDay >= 1020 && minutesOfDay < 1140),  // 17:00-19:00
  };
}

// Vocal energy: how the DJ should sound. `speed` multiplies the engine's default
// rate (>1 brisker); `register` is a delivery label nothing acts on yet. Derived
// from daypart + clock + a show's pinned energy, so speed 1.0 is a no-op.
const DAYPART_ENERGY: Record<string, { speed: number; register: string }> = {
  'early-morning': { speed: 0.98, register: 'warm' },      // gentle waking
  morning:         { speed: 1.02, register: 'even' },      // productive
  midday:          { speed: 1.06, register: 'up' },        // lunch-hour lift
  afternoon:       { speed: 1.0,  register: 'even' },       // neutral baseline
  'drive-time':    { speed: 1.06, register: 'up' },        // drive-home energy
  evening:         { speed: 0.97, register: 'warm' },      // wind down
  'late-evening':  { speed: 0.94, register: 'intimate' },  // late hours
  'after-hours':   { speed: 0.92, register: 'intimate' },  // graveyard
};

// A show's pinned energy overrides the daypart profile wholesale, including the
// late-night/commute clamps below — a schedule slot is an explicit operator call.
// '' (Any) keeps the autonomous daypart behaviour.
const SHOW_ENERGY_DELIVERY: Record<string, { speed: number; register: string }> = {
  high:   { speed: 1.06, register: 'up' },
  medium: { speed: 1.0,  register: 'even' },
  low:    { speed: 0.94, register: 'intimate' },
};

export function energyForDaypart(date = new Date()) {
  // A multi-energy show (#929) speaks at its LEAD energy: delivery needs one
  // register, though the pick filters treat all bands equally.
  const pinned = SHOW_ENERGY_DELIVERY[resolveActiveShow(date)?.energies?.[0] ?? ''];
  if (pinned) return pinned;
  const { period } = getTimeContext(date);
  const { isLateNight, isCommute } = getClockContext(date);
  const base = DAYPART_ENERGY[period] || { speed: 1.0, register: 'even' };
  // The small hours pull the pace down whatever daypart label the hour falls under.
  if (isLateNight) return { speed: Math.min(base.speed, 0.92), register: 'intimate' };
  // Commute windows push a touch above the daypart baseline.
  if (isCommute) return { speed: Math.max(base.speed, 1.05), register: 'up' };
  return base;
}

// Combined snapshot. Pass `at` to resolve the clock-derived parts (time,
// festival, date, clock, active show, dominantMood) for a future moment — the
// queue watcher picks the next track under the show that will be on air when it
// plays. Weather and listener count stay live.
export async function getFullContext(at?: Date) {
  const now = at ?? new Date();
  const time = getTimeContext(now);
  const weather = await getWeather();
  const festival = getFestivalContext(now);
  const date = getDateContext(now);
  const clock = getClockContext(now);

  // Ride Open-Meteo's is_day on the clock so the DJ stops describing daylight
  // after dark. Only set when known: a failed fetch leaves it unset and the model
  // infers from the wall clock.
  if (typeof weather?.isDay === 'boolean') (clock as any).isDark = !weather.isDay;

  // A scheduled show for this hour, if any; its mood wins everything below.
  const activeShow: any = resolveActiveShow(now);

  // Programme shows: ride today's episode angle on the show context, but only
  // once the session has rolled into this show — a previous session's plan must
  // not leak across the boundary.
  if (activeShow?.programme) {
    const sess = session.getSession();
    if (sess?.key === `show:${activeShow.id}` && sess.programme?.plan?.angle) {
      activeShow.episodeAngle = String(sess.programme.plan.angle);
    }
  }

  // Mood priority: show > festival > weather > time. dominantMood is a single
  // value by contract, so a multi-mood show leads with its FIRST mood; the pick
  // paths union the full list themselves (#929).
  const dominantMood = activeShow?.moods?.[0] || festival?.mood || weather.mood || time.mood;

  // From the cached Icecast monitor; `count` is null when unreadable, which
  // callers treat as "unknown".
  const listeners = { count: getListenerCount() };

  // The moment this context DESCRIBES, so a consumer needing a date does not fall
  // back to the wall clock and disagree with the activeShow resolved above.
  // Distinct from `date` (getDateContext's calendar strings).
  return { at: now.toISOString(), time, weather, festival, dominantMood, date, clock, activeShow, listeners };
}
