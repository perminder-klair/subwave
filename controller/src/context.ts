// Context engine — what should the DJ feel like right now?
// Used by the autonomous scheduler to pick mood-appropriate tracks.

import { config } from './config.js';
import { resolveActiveShow } from './settings.js';
import { getListenerCount } from './broadcast/listeners.js';
import { zonedParts, zonedISODate } from './time.js';

export function getTimeContext(date = new Date()) {
  const h = zonedParts(date).hour;
  if (h >= 5 && h < 9) return { period: 'early-morning', mood: 'morning', vibe: 'gentle waking', show: 'breakfast' };
  if (h >= 9 && h < 12) return { period: 'morning', mood: 'morning', vibe: 'productive', show: 'morning' };
  if (h >= 12 && h < 14) return { period: 'midday', mood: 'energetic', vibe: 'lunch hour', show: 'midday' };
  if (h >= 14 && h < 17) return { period: 'afternoon', mood: 'focus', vibe: 'sustained energy', show: 'afternoon' };
  // vibe reads 'end of the workday', not 'drive home': the vibe string lands in
  // every spoken-segment prompt (Period: drive-time (…)) and the commute framing
  // had the DJ doing traffic-jockey patter for two hours a day. The period/mood
  // keep their names — they drive pick energy, not talk.
  if (h >= 17 && h < 19) return { period: 'drive-time', mood: 'driving', vibe: 'end of the workday', show: 'drive-time' };
  if (h >= 19 && h < 22) return { period: 'evening', mood: 'evening', vibe: 'wind down', show: 'evening' };
  if (h >= 22 || h < 1) return { period: 'late-evening', mood: 'night', vibe: 'late hours', show: 'late' };
  return { period: 'after-hours', mood: 'reflective', vibe: 'after hours', show: 'graveyard' };
}

// Festival calendar — general / cross-cultural defaults. Edit to taste; the
// DJ leans into `mood` around these dates. Fixed-date only; lunar holidays
// (Easter, Eid, Lunar New Year) shift year-to-year and would need a
// per-year lookup.
const FESTIVALS = [
  { month: 1, day: 1, name: "New Year's Day", mood: 'celebratory' },
  { month: 2, day: 14, name: "Valentine's Day", mood: 'romantic' },
  { month: 3, day: 17, name: "St. Patrick's Day", mood: 'celebratory' },
  { month: 4, day: 13, name: 'Vaisakhi', mood: 'festival', windowDays: 1 },
  { month: 5, day: 1, name: 'May Day', mood: 'festival' },
  { month: 6, day: 21, name: 'Summer Solstice', mood: 'celebratory' },
  { month: 10, day: 31, name: 'Halloween', mood: 'festival' },
  { month: 11, day: 1, name: 'Diwali', mood: 'festival', windowDays: 3 },
  { month: 11, day: 5, name: 'Bonfire Night', mood: 'festival' },
  { month: 12, day: 21, name: 'Winter Solstice', mood: 'reflective' },
  { month: 12, day: 25, name: 'Christmas', mood: 'celebratory', windowDays: 1 },
  { month: 12, day: 26, name: 'Boxing Day', mood: 'celebratory' },
  { month: 12, day: 31, name: "New Year's Eve", mood: 'celebratory' },
];

export function getFestivalContext(date = new Date()) {
  const { month: m, day: d } = zonedParts(date);
  for (const f of FESTIVALS) {
    const window = f.windowDays || 0;
    if (f.month === m && Math.abs(f.day - d) <= window) {
      return { name: f.name, mood: f.mood };
    }
  }
  return null;
}

// Weather via Open-Meteo (no API key required)
let weatherCache: { data: any; fetchedAt: number } = { data: null, fetchedAt: 0 };
const WEATHER_TTL_MS = 30 * 60 * 1000;

// Force the next getWeather() call to re-fetch — used when the user changes
// their location in /settings.
export function invalidateWeatherCache() {
  weatherCache = { data: null, fetchedAt: 0 };
}

export async function getWeather() {
  if (weatherCache.data && Date.now() - weatherCache.fetchedAt < WEATHER_TTL_MS) {
    return weatherCache.data;
  }
  const imperial = config.weather.units === 'imperial';
  const tempUnit = imperial ? 'F' : 'C';
  try {
    const unitParam = imperial ? '&temperature_unit=fahrenheit' : '';
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${config.weather.lat}&longitude=${config.weather.lng}&current=temperature_2m,weather_code,is_day${unitParam}`;
    const res = await fetch(url);
    const data = await res.json() as any;
    const code = data.current.weather_code;
    const condition = mapWeatherCode(code);
    const result = {
      condition,
      mood: weatherToMood(condition),
      temp: Math.round(data.current.temperature_2m),
      tempUnit,
      isDay: data.current.is_day === 1,
      location: config.weather.locationName,
    };
    weatherCache = { data: result, fetchedAt: Date.now() };
    return result;
  } catch {
    return { condition: 'unknown', mood: null, temp: null, tempUnit, location: config.weather.locationName };
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

function weatherToMood(condition) {
  switch (condition) {
    case 'rainy':
    case 'foggy':
    case 'stormy':
      return 'rainy';
    case 'clear':
      return 'sunny';
    case 'snowy':
      return 'reflective';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Geocoding via Open-Meteo (no API key required) — powers the admin/onboarding
// location picker: type a place name, get back coordinates + IANA timezone so
// the operator never hand-copies lat/lng. Same provider we already use for
// weather, so no new dependency. Results are cached per lowercased query for a
// day (place coordinates don't move) with a soft entry cap to stay polite.
// ---------------------------------------------------------------------------
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
    // Refresh recency — Map iteration order is insertion order, so delete+set
    // keeps the oldest entry first for eviction.
    geocodeCache.delete(key);
    geocodeCache.set(key, hit);
    return hit.results;
  }

  const url =
    'https://geocoding-api.open-meteo.com/v1/search?name=' +
    encodeURIComponent(q) +
    '&count=6&language=en&format=json';
  const res = await fetch(url);
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

// Meteorological seasons, hemisphere-aware. Open-Meteo hands us the station's
// latitude, so a southern-hemisphere station (negative lat) reads July as
// winter, not summer (issue: Buenos Aires DJ talking about "summer" and "heat"
// in July). The southern seasons are the northern ones shifted six months.
function seasonFor(month /* 1-12 */, lat = config.weather.lat) {
  const m = lat < 0 ? ((month + 5) % 12) + 1 : month;
  if (m === 12 || m <= 2) return 'winter';
  if (m <= 5) return 'spring';
  if (m <= 8) return 'summer';
  return 'autumn';
}

export function getDateContext(date = new Date()) {
  const { dow, month, day } = zonedParts(date);
  return {
    // Station-zone date, not UTC — toISOString() was a day off near midnight
    // for any zone with an offset, even before timezone became configurable.
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
  return {
    hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    isWeekend: dow === 0 || dow === 6,
    isLateNight: h < 5,
    isCommute: (minutesOfDay >= 450 && minutesOfDay < 570) ||  // 07:30-09:30
               (minutesOfDay >= 1020 && minutesOfDay < 1140),  // 17:00-19:00
  };
}

// Vocal energy for the moment — how the DJ should *sound*, not what it says.
// `speed` is a multiplier on the engine's default speech rate (>1 brisker,
// <1 slower); higher is faster on every engine that supports it (piper,
// kokoro, cloud). `register` is a coarse delivery label carried forward for
// future style/emotion hints (cloud/chatterbox) — Stage 1 only acts on speed.
//
// Pure function of the existing daypart + clock so there's a single source of
// truth and it's trivially testable. A daypart that maps to speed 1.0
// (afternoon) yields no change at all, so a station with the default
// afternoon profile behaves exactly as before.
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

export function energyForDaypart(date = new Date()) {
  const { period } = getTimeContext(date);
  const { isLateNight, isCommute } = getClockContext(date);
  const base = DAYPART_ENERGY[period] || { speed: 1.0, register: 'even' };
  // The small hours pull the pace down regardless of which daypart label the
  // hour technically falls under (e.g. the 00:00–01:00 tail of 'late-evening').
  if (isLateNight) return { speed: Math.min(base.speed, 0.92), register: 'intimate' };
  // Commute windows get a touch more push than their daypart baseline.
  if (isCommute) return { speed: Math.max(base.speed, 1.05), register: 'up' };
  return base;
}

// Combined snapshot — what's the vibe right now?
export async function getFullContext() {
  const now = new Date();
  const time = getTimeContext(now);
  const weather = await getWeather();
  const festival = getFestivalContext(now);
  const date = getDateContext(now);
  const clock = getClockContext(now);

  // Open-Meteo reports whether the sun is up at the station right now; ride it
  // on the clock so the DJ stops describing dusk/daylight after dark (issue:
  // "night is starting to claim its place" / "shadows lengthen" said two hours
  // past sunset). Only set when known — a failed weather fetch leaves it unset
  // and the model falls back to inferring from the wall-clock time.
  if (typeof weather?.isDay === 'boolean') (clock as any).isDark = !weather.isDay;

  // A scheduled show for this hour, if any. Its mood wins everything below —
  // an empty hour leaves the station running autonomously.
  const activeShow = resolveActiveShow(now);

  // Show > festival > weather > time, in that order of priority for mood.
  const dominantMood = activeShow?.mood || festival?.mood || weather.mood || time.mood;

  // Live audience size, from the cached Icecast monitor. `count` is null when
  // it couldn't be read — callers treat that as "unknown" and stay quiet.
  const listeners = { count: getListenerCount() };

  return { time, weather, festival, dominantMood, date, clock, activeShow, listeners };
}
