// Frequency gate for the scheduler's station-ident crons.
//
// The station-ID and hourly-time-check crons tick at their most aggressive
// cadence (every quarter-hour / every hour); this function decides whether a
// given tick may fire under the frequency of the effective persona (the
// scheduled show's owner this hour, or the active persona) — quiet | moderate
// | aggressive.
//
// Between-track segments (weather, news, now-playing digs, facts, web search) are NOT
// gated here — the segment-director agent (skills/_agent.js) owns its own
// frequency floor. Lives outside scheduler.js to keep that file lean.

import * as settings from '../settings.js';
import { zonedParts } from '../time.js';

export function shouldFire(kind, now = new Date()) {
  // effectiveFrequency bumps a DJ-mode persona one rung up the ladder, so it
  // drops more idents / time checks — a working DJ marks the clock more often.
  const f = settings.effectiveFrequency(settings.getEffectivePersona(now));
  const m = now.getMinutes();

  if (kind === 'stationId') {
    if (f === 'quiet')    return m === 45;
    if (f === 'moderate') return m === 15 || m === 45;
    // Never at minute 0 — that's reserved for the hourly time check, which
    // always fires there. Letting both land on the hour stacked a station ID
    // and an hourly check back to back (and, with a between-track link, talking
    // over each other) — issue #310. Aggressive idents at 15/30/45 instead.
    return [15, 30, 45].includes(m);
  }

  if (kind === 'hourly') {
    // Station-zone hour — the every-other-hour cadence follows the operator's
    // clock. The minute slots above stay on process time on purpose: they
    // must align with when the crons actually fire.
    if (f === 'quiet') return zonedParts(now).hour % 2 === 0;
    return true;
  }

  return true;
}
