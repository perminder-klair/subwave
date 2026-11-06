// Open-Meteo WMO weather codes → the station's words for them. One place, read
// by the forecast fetch (context.ts) and its outlook. The old mapping read
// codes 1-3 as one "cloudy", so a mainly-clear night (code 1) went on air as
// "cloud sealed shut", and read rain showers (80-82) as "stormy". `condition`
// stays the six-word vocabulary settings.weatherMoods keys on; `describeCode`
// gives the forecast's own wording for what is spoken.

export const WEATHER_CONDITIONS = ['clear', 'cloudy', 'foggy', 'rainy', 'snowy', 'stormy'] as const;
export type WeatherCondition = typeof WEATHER_CONDITIONS[number];

export function isWeatherCondition(v: unknown): v is WeatherCondition {
  return typeof v === 'string' && (WEATHER_CONDITIONS as readonly string[]).includes(v);
}

// How far ahead the weather skill looks: the one number the fetch's row count
// (context.ts), buildOutlook's window and the "no longer expected" note share.
export const OUTLOOK_HOURS = 6;

const DESCRIPTIONS: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'light freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light rain showers', 81: 'rain showers', 82: 'heavy rain showers',
  85: 'light snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}

export function conditionForCode(code: unknown): WeatherCondition {
  if (!isFiniteInt(code)) return 'cloudy';
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'foggy';
  if (code >= 51 && code <= 57) return 'rainy';
  if (code >= 61 && code <= 67) return 'rainy';
  if (code >= 71 && code <= 77) return 'snowy';
  if (code === 85 || code === 86) return 'snowy';
  if (code >= 80 && code <= 82) return 'rainy';
  if (code >= 95 && code <= 99) return 'stormy';
  return 'cloudy';
}

export function describeCode(code: unknown): string | null {
  if (!isFiniteInt(code)) return null;
  return DESCRIPTIONS[code] ?? null;
}

export interface OutlookHour {
  // Whole hours from now, rounded; 0 is a row less than half an hour away.
  inHours: number;
  condition: WeatherCondition;
  conditions: string | null;
  temp: number | null;
  rainChancePct: number | null;
}

export interface HourlyForecast {
  time: string[];
  temperature_2m?: Array<number | null>;
  weather_code?: Array<number | null>;
  precipitation_probability?: Array<number | null>;
}

// Open-Meteo's local times (timezone=auto) carry no offset. Both the current
// reading and the hourly rows are on that one clock, so reading each as UTC
// keeps their differences right; the absolute instant is never used.
function parseTime(s: string): number | null {
  if (typeof s !== 'string') return null;
  let ms: number;
  if (s.length === 16) ms = Date.parse(s + ':00Z');
  else if (s.length === 19) ms = Date.parse(s + 'Z');
  else return null;
  return Number.isNaN(ms) ? null : ms;
}

const HOUR_MS = 3_600_000;

// The rows whose rounded distance from now is 0..`hours`. Open-Meteo's
// `current.time` moves in 15-minute steps, so a count of rows would cover only
// ~5¼ hours on a fetch at :45 (its first row is 15 minutes out); bounding by
// distance covers the whole window at any minute. `elapsedMs` ages a cached
// forecast: now is that much past the reading, so rows move closer and the
// ones that have passed drop out.
export function buildOutlook(
  hourly: HourlyForecast | null | undefined,
  currentTime: string,
  hours = OUTLOOK_HOURS,
  elapsedMs = 0,
): OutlookHour[] {
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const readingMs = parseTime(currentTime);
  if (readingMs === null) return [];
  const nowMs = readingMs + Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);

  const result: OutlookHour[] = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const rowMs = parseTime(hourly.time[i]);
    if (rowMs === null) continue;
    if (rowMs <= nowMs) continue;
    const inHours = Math.round((rowMs - nowMs) / HOUR_MS);
    if (inHours > hours) continue;

    const code = hourly.weather_code?.[i];
    const tempRaw = hourly.temperature_2m?.[i];
    const rainRaw = hourly.precipitation_probability?.[i];

    const temp = typeof tempRaw === 'number' && Number.isFinite(tempRaw)
      ? Math.round(tempRaw)
      : null;
    const rainChancePct = typeof rainRaw === 'number' && Number.isFinite(rainRaw)
      ? Math.round(Math.min(100, Math.max(0, rainRaw)))
      : null;

    result.push({
      inHours,
      condition: conditionForCode(code),
      conditions: describeCode(code),
      temp,
      rainChancePct,
    });
  }
  return result;
}

// Falling weather, snow included: a snowy row is neither dry nor "drying out".
export function isWet(cond: string): boolean {
  return cond === 'rainy' || cond === 'stormy' || cond === 'snowy';
}

// Rain and thunderstorms are one kind of wet, snow the other; a change between
// them is news, a change within one is not.
function wetKind(cond: string): 'rain' | 'snow' {
  return cond === 'snowy' ? 'snow' : 'rain';
}

// Cold enough that precipitation would fall as snow: at or below freezing, in
// the reading's own unit. Used only for a row whose code names no
// precipitation, since a wet code already says which it is.
function isFreezing(temp: number | null, unit: 'C' | 'F'): boolean {
  return temp !== null && temp <= (unit === 'F' ? 32 : 0);
}

// At or above this chance of precipitation a row is "likely", and only then is
// the chance quoted: "likely (5% chance)" contradicts itself on air.
const LIKELY_PCT = 50;

function isLikely(r: OutlookHour): boolean {
  return r.rainChancePct !== null && r.rainChancePct >= LIKELY_PCT;
}

function when(n: number): string {
  if (n <= 0) return 'within the hour';
  return n === 1 ? 'in about 1 hour' : `in about ${n} hours`;
}

// A temperature swing worth a note: 3 °C, or its Fahrenheit equivalent (5 °F).
function swingThreshold(unit: 'C' | 'F'): number {
  return unit === 'F' ? 5 : 3;
}

// What precipitation an outlook said was on the way, as weather-policy.ts
// remembers it: rain (drizzle, showers, or a high chance on a dry-code row
// above freezing), snow, or thunderstorms.
export type ComingPrecip = 'rain' | 'snow' | 'storm';

export type OutlookNoteKind =
  | 'rain-likely' | 'rain-possible'
  | 'snow-likely' | 'snow-possible'
  | 'storm-likely' | 'storm-possible'
  | 'precip-likely'
  | 'turning-rain' | 'turning-snow'
  | 'drying' | 'clearing' | 'clouding' | 'warmer' | 'cooler'
  // Never from outlookEvents: weather-policy.ts adds one (withdrawnNote) when
  // precipitation an aired outlook promised is no longer in the forecast.
  | `${ComingPrecip}-withdrawn`;

export interface OutlookNote {
  // What the note is about, without its timing: an unchanged list of kinds is
  // nothing new to say, however many hours away the rain has moved.
  kind: OutlookNoteKind;
  text: string;
}

// The note for precipitation an aired outlook promised and the forecast no
// longer holds anywhere in the window, so the tool never reports a changed
// outlook with nothing in it to say.
export function withdrawnNote(what: ComingPrecip): OutlookNote {
  const word = what === 'storm' ? 'thunderstorms' : what;
  return { kind: `${what}-withdrawn`, text: `${word} no longer expected in the next ${OUTLOOK_HOURS} hours` };
}

export interface OutlookCurrent {
  condition: string;
  temp: number | null;
  tempUnit?: string | null;
}

export function outlookEvents(current: OutlookCurrent, outlook: OutlookHour[]): OutlookNote[] {
  if (outlook.length === 0) return [];

  const notes: OutlookNote[] = [];
  const unit: 'C' | 'F' = current.tempUnit === 'F' ? 'F' : 'C';

  // 1. Precipitation coming (current not wet). The first row whose chance
  //    clears LIKELY_PCT, whatever its code, so a 10% drizzle row in an hour
  //    cannot hide a 90% downpour in three; failing that, the first row that is
  //    wet by its code, as a possibility.
  if (!isWet(current.condition)) {
    const row = outlook.find(isLikely) ?? outlook.find(r => isWet(r.condition));
    if (row) {
      const likely = isLikely(row);
      const chance = likely ? ` (${row.rainChancePct}% chance)` : '';
      if (row.condition === 'stormy') {
        notes.push({
          kind: likely ? 'storm-likely' : 'storm-possible',
          text: `thunderstorms ${likely ? 'likely' : 'possible'} ${when(row.inHours)}${chance}`,
        });
      } else if (isWet(row.condition)) {
        const kind = wetKind(row.condition);
        notes.push(likely
          ? { kind: `${kind}-likely`, text: `${kind} likely ${when(row.inHours)}${chance}` }
          // Wet by code with a low or unknown chance: the forecast's own
          // wording, as a possibility, with no percentage.
          : { kind: `${kind}-possible`, text: `${row.conditions ?? kind} possible ${when(row.inHours)}` });
      } else {
        // A high chance on a row whose code names no precipitation (clear,
        // cloudy, fog). Open-Meteo's chance covers rain and snow alike, so the
        // row keeps its own wording and is never called rain: snow when it is
        // cold enough, else just precipitation.
        const what = isFreezing(row.temp, unit) ? 'snow' : 'precipitation';
        notes.push({
          kind: what === 'snow' ? 'snow-likely' : 'precip-likely',
          text: `${row.conditions ?? row.condition} ${when(row.inHours)}, with a ${row.rainChancePct}% chance of ${what}`,
        });
      }
    }
  }

  // 2. Wet now: when it stops, or when rain turns to snow (or back), whichever
  //    comes first. A dry row needs a low chance as well as a dry code.
  if (isWet(current.condition)) {
    const now = wetKind(current.condition);
    const row = outlook.find(r => isWet(r.condition)
      ? wetKind(r.condition) !== now
      : r.rainChancePct === null || r.rainChancePct < 30);
    if (row && isWet(row.condition)) {
      const to = wetKind(row.condition);
      const likely = isLikely(row);
      notes.push({
        kind: `turning-${to}`,
        text: likely
          ? `turning to ${to} ${when(row.inHours)} (${row.rainChancePct}% chance)`
          : `possibly turning to ${to} ${when(row.inHours)}`,
      });
    } else if (row) {
      notes.push({ kind: 'drying', text: `${now === 'snow' ? 'the snow stopping' : 'drying out'} ${when(row.inHours)}` });
    }
  }

  // 3. Sky change (current not wet AND no precipitation note produced)
  const precipNoteProduced = notes.length > 0;
  if (!isWet(current.condition) && !precipNoteProduced) {
    if ((current.condition === 'cloudy' || current.condition === 'foggy')) {
      const clearRow = outlook.find(r => r.condition === 'clear');
      if (clearRow) notes.push({ kind: 'clearing', text: `clearing ${when(clearRow.inHours)}` });
    } else if (current.condition === 'clear') {
      const cloudRow = outlook.find(r => r.condition === 'cloudy');
      if (cloudRow) notes.push({ kind: 'clouding', text: `clouding over ${when(cloudRow.inHours)}` });
    }
  }

  // 4. Temperature, in the reading's own unit
  if (current.temp !== null) {
    const last = outlook[outlook.length - 1];
    if (last.temp !== null) {
      const diff = last.temp - current.temp;
      if (Math.abs(diff) >= swingThreshold(unit)) {
        const dir = diff < 0 ? 'down to' : 'up to';
        const unitWord = unit === 'F' ? 'Fahrenheit' : 'Celsius';
        notes.push({
          kind: diff < 0 ? 'cooler' : 'warmer',
          text: `${dir} ${last.temp} degrees ${unitWord} ${when(last.inHours)}`,
        });
      }
    }
  }

  return notes;
}

export function outlookNotes(current: OutlookCurrent, outlook: OutlookHour[]): string[] {
  return outlookEvents(current, outlook).map(n => n.text);
}
