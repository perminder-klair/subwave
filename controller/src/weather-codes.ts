// Open-Meteo WMO weather codes → the station's words for them. One place, read
// by the forecast fetch (context.ts) and its outlook. The old mapping read
// codes 1-3 as one "cloudy", so a mainly-clear night (code 1) went on air as
// "cloud sealed shut", and read rain showers (80-82) as "stormy". `condition`
// stays the six-word vocabulary settings.weatherMoods keys on; `describeCode`
// gives the forecast's own wording for what is spoken.

export type WeatherCondition = 'clear' | 'cloudy' | 'foggy' | 'rainy' | 'snowy' | 'stormy';

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

function parseTime(s: string): number | null {
  if (typeof s !== 'string') return null;
  let ms: number;
  if (s.length === 16) ms = Date.parse(s + ':00Z');
  else if (s.length === 19) ms = Date.parse(s + 'Z');
  else return null;
  return Number.isNaN(ms) ? null : ms;
}

export function buildOutlook(
  hourly: HourlyForecast | null | undefined,
  currentTime: string,
  hours = 6,
): OutlookHour[] {
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const currentMs = parseTime(currentTime);
  if (currentMs === null) return [];

  const result: OutlookHour[] = [];
  for (let i = 0; i < hourly.time.length && result.length < hours; i++) {
    const rowMs = parseTime(hourly.time[i]);
    if (rowMs === null) continue;
    if (rowMs <= currentMs) continue;

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
      inHours: Math.max(1, Math.round((rowMs - currentMs) / 3600000)),
      condition: conditionForCode(code),
      conditions: describeCode(code),
      temp,
      rainChancePct,
    });
  }
  return result;
}

function isWet(cond: string): boolean {
  return cond === 'rainy' || cond === 'stormy';
}

function hoursLabel(n: number): string {
  return n === 1 ? '1 hour' : `${n} hours`;
}

export function outlookNotes(
  current: { condition: string; temp: number | null },
  outlook: OutlookHour[],
): string[] {
  if (outlook.length === 0) return [];

  const notes: string[] = [];

  // 1. Rain coming (current not wet)
  if (!isWet(current.condition)) {
    const wetRow = outlook.find(
      r => isWet(r.condition) || (r.rainChancePct !== null && r.rainChancePct >= 50),
    );
    if (wetRow) {
      const base = wetRow.condition === 'stormy'
        ? `thunderstorms possible in about ${hoursLabel(wetRow.inHours)}`
        : `rain likely in about ${hoursLabel(wetRow.inHours)}`;
      notes.push(
        wetRow.rainChancePct !== null
          ? `${base} (${wetRow.rainChancePct}% chance)`
          : base,
      );
    }
  }

  // 2. Drying out (current wet)
  if (isWet(current.condition)) {
    const dryRow = outlook.find(
      r => !isWet(r.condition) && (r.rainChancePct === null || r.rainChancePct < 30),
    );
    if (dryRow) {
      notes.push(`drying out in about ${hoursLabel(dryRow.inHours)}`);
    }
  }

  // 3. Sky change (current not wet AND no rain note produced)
  const rainNoteProduced = notes.length > 0;
  if (!isWet(current.condition) && !rainNoteProduced) {
    if ((current.condition === 'cloudy' || current.condition === 'foggy')) {
      const clearRow = outlook.find(r => r.condition === 'clear');
      if (clearRow) notes.push(`clearing in about ${hoursLabel(clearRow.inHours)}`);
    } else if (current.condition === 'clear') {
      const cloudRow = outlook.find(r => r.condition === 'cloudy');
      if (cloudRow) notes.push(`clouding over in about ${hoursLabel(cloudRow.inHours)}`);
    }
  }

  // 4. Temperature
  if (current.temp !== null) {
    const last = outlook[outlook.length - 1];
    if (last.temp !== null) {
      const diff = last.temp - current.temp;
      if (Math.abs(diff) >= 3) {
        const dir = diff < 0 ? 'down to' : 'up to';
        notes.push(`${dir} ${last.temp} degrees in about ${hoursLabel(last.inHours)}`);
      }
    }
  }

  return notes;
}
