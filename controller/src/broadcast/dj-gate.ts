// Frequency gate for the scheduler's station-ident crons.
//
// The station-ID and hourly-time-check crons tick at their most aggressive
// cadence (every quarter-hour / every hour); this function decides whether a
// given tick may fire under the frequency of the effective persona (the
// scheduled show's owner this hour, or the active persona) — quiet | moderate
// | aggressive.
//
// Between-track segments (weather, news, traffic, facts, web search) are NOT
// gated here — the segment-director agent (skills/_agent.js) owns its own
// frequency floor. Lives outside scheduler.js to keep that file lean.

import * as settings from '../settings.js';

export function shouldFire(kind, now = new Date()) {
  // effectiveFrequency bumps a DJ-mode persona one rung up the ladder, so it
  // drops more idents / time checks — a working DJ marks the clock more often.
  const f = settings.effectiveFrequency(settings.getEffectivePersona(now));
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

  return true;
}
