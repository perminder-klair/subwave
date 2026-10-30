// The scene registry, and the rule that picks one for the station's hour
// and weather when the listener hasn't chosen.

import { aurora } from './aurora';
import { campfire } from './campfire';
import { coast } from './coast';
import { sunrise } from './sunrise';
import type { Scene, SceneId, Weather } from './kit';

export type { Scene, SceneDraw, SceneFrame, SceneId, Weather } from './kit';
export { drawWeather } from './weather';

export const SCENES: readonly Scene[] = [campfire, aurora, sunrise, coast];

/** A listener's choice: one scene, or follow the station. */
export type ScenePick = SceneId | 'auto';

export function isScenePick(v: unknown): v is ScenePick {
  return v === 'auto' || SCENES.some(s => s.id === v);
}

export function sceneById(id: SceneId): Scene {
  return SCENES.find(s => s.id === id) ?? SCENES[0]!;
}

/** The controller's day periods (context.ts PERIOD_TABLE), for when the feed
 *  hasn't said which one it is. */
export function periodForHour(h: number): string {
  if (h >= 5 && h < 9) return 'early-morning';
  if (h >= 9 && h < 12) return 'morning';
  if (h >= 12 && h < 14) return 'midday';
  if (h >= 14 && h < 17) return 'afternoon';
  if (h >= 17 && h < 19) return 'drive-time';
  if (h >= 19 && h < 22) return 'evening';
  return h >= 22 || h < 1 ? 'late-evening' : 'after-hours';
}

/** The controller's simplified WMO condition to an overlay. */
export function weatherOf(condition: string | null | undefined): Weather {
  switch (condition) {
    case 'rainy': return 'rain';
    case 'snowy': return 'snow';
    case 'foggy': return 'fog';
    case 'stormy': return 'storm';
    case 'cloudy': return 'cloudy';
    default: return 'clear';
  }
}

const BY_PERIOD: Record<string, SceneId> = {
  'early-morning': 'sunrise',
  morning: 'coast',
  midday: 'coast',
  afternoon: 'coast',
  'drive-time': 'sunrise',
  evening: 'campfire',
  'late-evening': 'aurora',
  'after-hours': 'aurora',
};

/** Dawn and golden hour get the balloons, the working day the coast, the
 *  evening the fire, the small hours the aurora — and a snowy night goes to
 *  the cabin whatever the clock says. Falls back to the first registered
 *  scene, so a registry without the chosen one still renders. */
export function autoSceneId(period: string | null | undefined, weather: Weather): SceneId {
  const night = period === 'evening' || period === 'late-evening' || period === 'after-hours';
  const want: SceneId = weather === 'snow' && night ? 'aurora' : BY_PERIOD[period ?? ''] ?? 'campfire';
  return SCENES.some(s => s.id === want) ? want : SCENES[0]!.id;
}
