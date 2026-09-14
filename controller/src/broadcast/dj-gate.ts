// Frequency gate for the station-ident / hourly / banter talk rows: may this
// tick fire under the effective persona's frequency (quiet|moderate|chatty|
// aggressive)? Between-track segments are NOT gated here — the segment director
// (skills/_agent.js) owns its own frequency floor.

import * as settings from '../settings.js';
import { zonedParts } from '../time.js';
import { autoVoiceAllowed } from './voice-policy.js';
import { autoTimeCheckAllowed } from './clock-policy.js';
import { talkSlot, openMinuteFor } from './talk-scheduler.js';

export function shouldFire(kind, now = new Date()) {
  // Voice switch sits above the ladder: it isn't a cadence. Manual
  // /dj/segment triggers never reach here, so they stay exempt.
  if (!autoVoiceAllowed()) return false;

  // effectiveFrequency bumps a DJ-mode persona one rung up the ladder.
  const f = settings.effectiveFrequency(settings.getEffectivePersona(now));
  const m = now.getMinutes();

  // 'silent' never auto-fires; manual triggers bypass this gate entirely.
  if (f === 'silent') return false;

  if (kind === 'stationId') {
    // Ask per SLOT, not per minute: an ident slot is a ten-minute window, so
    // a retry at :18 must read as the :15 chance (#1419). Opening minutes are
    // :15/:30/:45, never :00 — that is the hourly check's (#310).
    const slot = openMinuteFor(talkSlot('station-id'), m);
    if (slot == null) return false;
    if (f === 'quiet')    return slot === 45;
    if (f === 'moderate') return slot === 15 || slot === 45;
    // Chatty and aggressive both ident at :15/:30/:45 (three an hour).
    return true;
  }

  if (kind === 'hourly') {
    // Clock switch. Gated here rather than in generateHourlyTime so the
    // operator's manual "Time check" pad keeps speaking the time.
    if (!autoTimeCheckAllowed()) return false;
    // Station-zone hour, so the every-other-hour cadence follows the
    // operator's clock. Minute slots stay on process time to match the cron.
    if (f === 'quiet') return zonedParts(now).hour % 2 === 0;
    return true;
  }

  if (kind === 'banter') {
    // Banter slots open at :20/:50, minutes no other wall-clock talker owns.
    // Asked per slot so a retry minute (:24) reads as its opener (:20).
    const slot = openMinuteFor(talkSlot('banter'), m);
    if (slot == null) return false;
    // Quiet never auto-fires banter (manual trigger still works), moderate
    // gets one an hour, chatty/aggressive get both slots.
    if (f === 'quiet')    return false;
    if (f === 'moderate') return slot === 20;
    return true;
  }

  return true;
}
