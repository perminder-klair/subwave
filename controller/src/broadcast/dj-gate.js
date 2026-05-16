// Frequency gate for autonomous DJ events.
//
// Crons + the skills registry tick at their most aggressive cadence; this
// function decides whether a given tick is allowed to fire under the
// frequency of the effective persona (the scheduled show's owner this hour,
// or the active persona) — quiet | moderate | aggressive.
//
// Lives outside scheduler.js so both the scheduler crons and the skill
// registry can import it without a circular dependency.

import * as settings from '../settings.js';

export function shouldFire(kind, now = new Date()) {
  const f = settings.getEffectivePersona(now)?.frequency || 'moderate';
  const m = now.getMinutes();

  if (kind === 'stationId') {
    if (f === 'quiet')    return m === 45;
    if (f === 'moderate') return m === 15 || m === 45;
    return [0, 15, 30, 45].includes(m);
  }

  if (kind === 'hourly') {
    if (f === 'quiet') return now.getHours() % 2 === 0;
    return true;
  }

  // Skills that have a "could fire any minute" rhythm and want the
  // frequency setting to throttle them. Used by weather (in the skill) and
  // the news/traffic/random-facts/web-search skills.
  if (kind === 'weather' || kind === 'news' || kind === 'traffic'
      || kind === 'random-facts' || kind === 'web-search') {
    if (f === 'quiet')    return m === 0;
    if (f === 'moderate') return m === 0 || m === 30;
    return true;
  }

  return true;
}
