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
// (clear, cloudy, …). The outlook is judged by news class, the note kinds
// (weather-codes.ts outlookEvents) with three things taken out, each of which
// had the weather re-airing with nothing new to say:
// - timing: a kind carries none, so rain moving from three hours off to two is
//   not news;
// - temperature: `cooler`/`warmer` compare now with the furthest row, which
//   moves on every hour, so they came and went with the time of day. They stay
//   in what the tool says; they never make it news;
// - confidence: rain possible and rain likely are one class (`rain`, with a
//   high chance on a dry-code row), so a chance hovering at 50% does not flip
//   it. The same for snow and thunderstorms.
// Only a class the last aired outlook did not have is news; one that has gone
// is not, with one exception: precipitation the aired outlook promised that the
// forecast no longer holds at all, under a dry sky. That is news, and comes
// with its own note (`withdrawn`, which the tool adds to its outlook), so a
// changed outlook is never an empty one.
//
// `lastWeatherOutlook` stays null until an aired segment's tool reported an
// outlook. A station still running a seeded tool.mjs from before the outlook
// (kept until the operator presses Reset on the skill) never reports one, so
// once it has aired weather its outlook is never news and the sky alone
// decides, as it did before. A run whose model wrote from the context line
// without calling the tool records the sky only: that is all it was given.

import { isWeatherCondition, isWet, withdrawnNote, type ComingPrecip, type OutlookNote, type OutlookNoteKind, type WeatherCondition } from '../weather-codes.js';

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
  // Notes for precipitation the last aired outlook promised and the forecast
  // no longer holds; non-empty only when that is what changed the outlook.
  withdrawn: OutlookNote[];
}

// What an aired weather segment records: the condition its tool reported and,
// when the tool reported an outlook, that outlook's key.
export interface WeatherMention {
  condition: WeatherCondition;
  outlook: string | null;
}

type NewsClass = ComingPrecip | 'turning-rain' | 'turning-snow' | 'drying' | 'clearing' | 'clouding';

// Every kind's news class; null is never news. A Record, so a kind added to
// OutlookNoteKind without a class here fails to compile.
const NEWS_CLASS: Record<OutlookNoteKind, NewsClass | null> = {
  'rain-likely': 'rain', 'rain-possible': 'rain', 'precip-likely': 'rain',
  'snow-likely': 'snow', 'snow-possible': 'snow',
  'storm-likely': 'storm', 'storm-possible': 'storm',
  'turning-rain': 'turning-rain', 'turning-snow': 'turning-snow',
  drying: 'drying', clearing: 'clearing', clouding: 'clouding',
  warmer: null, cooler: null,
  'rain-withdrawn': null, 'snow-withdrawn': null, 'storm-withdrawn': null,
};
const NEWS_CLASSES: ReadonlySet<string> = new Set(Object.values(NEWS_CLASS).filter(c => c !== null));
const COMING: readonly ComingPrecip[] = ['rain', 'snow', 'storm'];

// A kind's class, or a stored class name read back; null for anything else.
function classOf(token: string): NewsClass | null {
  if (Object.hasOwn(NEWS_CLASS, token)) return NEWS_CLASS[token as OutlookNoteKind];
  return NEWS_CLASSES.has(token) ? token as NewsClass : null;
}

function classesOf(tokens: readonly string[]): Set<NewsClass> {
  const out = new Set<NewsClass>();
  for (const t of tokens) {
    const c = typeof t === 'string' ? classOf(t) : null;
    if (c) out.add(c);
  }
  return out;
}

// The one comparison key for an outlook: its news classes, sorted, so the same
// outlook always gives the same key whatever order its notes came in.
export function outlookKey(kinds: readonly string[]): string {
  return [...classesOf(kinds)].sort().join(',');
}

export function weatherNews(reading: WeatherReading | null | undefined, memory: Partial<WeatherMemory> | null | undefined): WeatherNews {
  const condition = reading?.condition;
  if (!isWeatherCondition(condition)) return { skyChanged: false, outlookChanged: false, withdrawn: [] };
  const lastSky = memory?.lastWeatherCondition ?? null;
  const lastOutlook = memory?.lastWeatherOutlook ?? null;
  const skyChanged = condition !== lastSky;
  const kinds = reading?.kinds;
  if (!Array.isArray(kinds)) return { skyChanged, outlookChanged: false, withdrawn: [] };
  const now = classesOf(kinds);
  if (lastOutlook === null) {
    // Nothing recorded yet. Before any weather segment, whatever the outlook
    // says is unsaid. After one whose tool gave no outlook, the sky decides.
    return { skyChanged, outlookChanged: lastSky === null && now.size > 0, withdrawn: [] };
  }
  const aired = classesOf(lastOutlook.split(','));
  const added = [...now].some(c => !aired.has(c));
  // Withdrawn only when no precipitation is coming at all and none is falling:
  // rain turning into a snow note is the snow's news, and rain that arrived is
  // the sky's.
  const stillComing = COMING.some(c => now.has(c));
  const withdrawn = isWet(condition) || stillComing
    ? []
    : COMING.filter(c => aired.has(c)).map(withdrawnNote);
  return { skyChanged, outlookChanged: added || withdrawn.length > 0, withdrawn };
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
