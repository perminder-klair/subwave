// Context engine — what should the DJ feel like right now?
// Used by the autonomous scheduler to pick mood-appropriate tracks.

import { config } from './config.js';
import { resolveActiveShow } from './settings.js';
import { getListenerCount } from './broadcast/listeners.js';

export function getTimeContext(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 9) return { period: 'early-morning', mood: 'morning', vibe: 'gentle waking', show: 'breakfast' };
  if (h >= 9 && h < 12) return { period: 'morning', mood: 'morning', vibe: 'productive', show: 'morning' };
  if (h >= 12 && h < 14) return { period: 'midday', mood: 'energetic', vibe: 'lunch hour', show: 'midday' };
  if (h >= 14 && h < 17) return { period: 'afternoon', mood: 'focus', vibe: 'sustained energy', show: 'afternoon' };
  if (h >= 17 && h < 19) return { period: 'drive-time', mood: 'driving', vibe: 'drive home', show: 'drive-time' };
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
  const m = date.getMonth() + 1;
  const d = date.getDate();
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

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];

// Northern-hemisphere meteorological seasons — the box is in Wolverhampton.
function seasonFor(month /* 1-12 */) {
  if (month === 12 || month <= 2) return 'winter';
  if (month <= 5) return 'spring';
  if (month <= 8) return 'summer';
  return 'autumn';
}

export function getDateContext(date = new Date()) {
  const dow = date.getDay();
  const month = date.getMonth() + 1;
  return {
    iso: date.toISOString().slice(0, 10),
    dayOfWeek: dow,
    dayLabel: DAY_LABELS[dow],
    monthLabel: MONTH_LABELS[month - 1],
    dayOfMonth: date.getDate(),
    season: seasonFor(month),
  };
}

export function getClockContext(date = new Date()) {
  const h = date.getHours();
  const m = date.getMinutes();
  const minutesOfDay = h * 60 + m;
  const dow = date.getDay();
  return {
    hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    isWeekend: dow === 0 || dow === 6,
    isLateNight: h < 5,
    isCommute: (minutesOfDay >= 450 && minutesOfDay < 570) ||  // 07:30-09:30
               (minutesOfDay >= 1020 && minutesOfDay < 1140),  // 17:00-19:00
  };
}

// Combined snapshot — what's the vibe right now?
export async function getFullContext() {
  const now = new Date();
  const time = getTimeContext(now);
  const weather = await getWeather();
  const festival = getFestivalContext(now);
  const date = getDateContext(now);
  const clock = getClockContext(now);

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
