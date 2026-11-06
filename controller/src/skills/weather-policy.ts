// Whether the weather is news, and what an aired weather segment counts as
// having said. One place for a decision three callers reach: the simple path's
// chooseCapability, the agentic tick's "weather alone and nothing new" skip
// (skills/_agent.ts), and the weather tool's own flags, which reach it through
// services.weatherNews because a seeded tool.mjs cannot import the controller.
// Two copies disagreed once: the tool called a new outlook news while both
// gates looked only at the sky, so a rain warning under an unchanged sky never
// aired.
//
// The sky and the outlook are judged apart. The sky is the coarse condition
// (clear, cloudy, …). The outlook is what its notes are about: their kinds,
// without timing (weather-codes.ts outlookEvents), so rain moving from three
// hours off to two is not news, and rain going from possible to likely is.
//
// `lastWeatherOutlook` stays null until an aired segment's tool reported an
// outlook. A station still running a seeded tool.mjs from before the outlook
// (kept until the operator presses Reset on the skill) never reports one, so
// once it has aired weather its outlook is never news and the sky alone
// decides, as it did before. A run whose model wrote from the context line
// without calling the tool records the sky only: that is all it was given.

import { isWeatherCondition, type OutlookNoteKind, type WeatherCondition } from '../weather-codes.js';

export interface WeatherMemory {
  lastWeatherCondition: WeatherCondition | null;
  lastWeatherOutlook: string | null;
}

export interface WeatherReading {
  // The reading's condition; anything outside the six (or 'unknown') is no
  // reading, which is never news.
  condition: string | null | undefined;
  // The outlook's note kinds. Absent or null: no outlook is known, which is
  // never news.
  kinds?: readonly OutlookNoteKind[] | null;
}

export interface WeatherNews {
  skyChanged: boolean;
  outlookChanged: boolean;
}

// What an aired weather segment records: the condition its tool reported and,
// when the tool reported an outlook, that outlook's key.
export interface WeatherMention {
  condition: WeatherCondition;
  outlook: string | null;
}

// The one comparison key for an outlook. outlookEvents emits kinds in a fixed
// order, so the same notes always give the same key.
export function outlookKey(kinds: readonly string[]): string {
  return kinds.join(',');
}

export function weatherNews(reading: WeatherReading | null | undefined, memory: Partial<WeatherMemory> | null | undefined): WeatherNews {
  const condition = reading?.condition;
  if (!isWeatherCondition(condition)) return { skyChanged: false, outlookChanged: false };
  const lastSky = memory?.lastWeatherCondition ?? null;
  const lastOutlook = memory?.lastWeatherOutlook ?? null;
  const skyChanged = condition !== lastSky;
  const kinds = reading?.kinds;
  let outlookChanged = false;
  if (Array.isArray(kinds)) {
    const key = outlookKey(kinds);
    outlookChanged = lastOutlook !== null
      ? key !== lastOutlook
      // Nothing recorded yet. Before any weather segment, whatever the outlook
      // says is unsaid. After one whose tool gave no outlook, the sky decides.
      : lastSky === null && key !== '';
  }
  return { skyChanged, outlookChanged };
}

export function isWeatherNews(reading: WeatherReading | null | undefined, memory: Partial<WeatherMemory> | null | undefined): boolean {
  const news = weatherNews(reading, memory);
  return news.skyChanged || news.outlookChanged;
}

// The mention a weather tool result stands for, or null for a result with no
// reading (`{ available: false }`, `{ error }`). `outlookKinds` is how the
// built-in tool says which outlook it handed over; a result without it (an
// older seeded copy) mentions the sky only.
export function weatherMention(data: unknown): WeatherMention | null {
  const d = data as { available?: unknown; condition?: unknown; outlookKinds?: unknown } | null | undefined;
  if (!d || d.available !== true || !isWeatherCondition(d.condition)) return null;
  const kinds = Array.isArray(d.outlookKinds) && d.outlookKinds.every(k => typeof k === 'string')
    ? d.outlookKinds as string[]
    : null;
  return { condition: d.condition, outlook: kinds ? outlookKey(kinds) : null };
}

// A weather segment found an air path. `mention` is what its tool returned
// during that run; without one, only the sky (the context line) was given.
export function recordWeatherAired(memory: WeatherMemory, condition: string | null | undefined, mention: WeatherMention | null): void {
  if (mention) {
    memory.lastWeatherCondition = mention.condition;
    if (mention.outlook !== null) memory.lastWeatherOutlook = mention.outlook;
    return;
  }
  if (isWeatherCondition(condition)) memory.lastWeatherCondition = condition;
}
