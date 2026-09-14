// Station-wide clock switch (`settings.djSpeakClock`). Call sites ask; this
// module answers, so the policy lives in one place.
//
// It is a predicate rather than a context-allowlist entry because the clock
// reaches a model by four routes: the "Local time" context line, the station-ID
// "nod to the clock" nudge, the pick agent's own clause (which never calls
// buildContextLines), and the hourly time-check cron. A generator that grows
// its own clock line asks here too.
//
// Daypart colour ("after dark", isDark) stays when the clock is off — it is
// atmosphere, not a clock reading. Manual /dj/segment triggers stay exempt,
// which is why the gate sits on the hourly CRON and never inside
// generateHourlyTime. Read live, so the toggle applies on the next tick.

import * as settings from '../settings.js';

// Absent/non-boolean reads as ON, so an upgrade is byte-identical.
export function clockEnabled(): boolean {
  return settings.get()?.djSpeakClock !== false;
}

// May a spoken line state the wall-clock time?
export function speakClockAllowed(): boolean {
  return clockEnabled();
}

// A boundary-deferred ident's daypart can go stale while its WAV waits for a
// seam. Stamp only a daypart the model was allowed to use: an ident written
// with the clock off made no clock claim and must not be dropped later.
export function stationIdDaypartStamp(daypart: unknown, clockAllowed: boolean): string | null {
  if (!clockAllowed || typeof daypart !== 'string') return null;
  return daypart.trim() || null;
}

// Air-time backstop for the stamp above. Missing/malformed stamps fail OPEN:
// they mean no validated daypart claim reached this channel.
export function stationIdDaypartDrifted(stamped: unknown, live: unknown): boolean {
  if (typeof stamped !== 'string' || !stamped.trim()) return false;
  if (typeof live !== 'string' || !live.trim()) return false;
  return stamped.trim() !== live.trim();
}

// May the AUTOMATIC top-of-the-hour time check fire? Manual runners must NOT
// call this — bypassing the gate is what preserves the operator's pad.
export function autoTimeCheckAllowed(): boolean {
  return clockEnabled();
}

export function clockStatus() {
  return { enabled: clockEnabled() };
}
