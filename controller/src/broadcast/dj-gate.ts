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
import { autoVoiceAllowed } from './voice-policy.js';
import { autoTimeCheckAllowed } from './clock-policy.js';
import { talkSlot, openMinuteFor } from './talk-scheduler.js';

export function shouldFire(kind, now = new Date()) {
  // Station-wide voice switch (settings.tts.enabled). Sits above the frequency
  // ladder because it isn't a cadence — it's off. Manual /dj/segment triggers
  // never reach here, so they stay exempt exactly as they are from 'silent'.
  if (!autoVoiceAllowed()) return false;

  // effectiveFrequency bumps a DJ-mode persona one rung up the ladder, so it
  // drops more idents / time checks — a working DJ marks the clock more often.
  const f = settings.effectiveFrequency(settings.getEffectivePersona(now));
  const m = now.getMinutes();

  // 'silent' never auto-fires anything — manual /dj/segment triggers bypass
  // this gate entirely (scheduler's command runners don't call shouldFire).
  if (f === 'silent') return false;

  if (kind === 'stationId') {
    // Which CHANCE this minute belongs to, not which minute it is. An ident
    // slot is a ten-minute window (talk-scheduler.ts), so a retry at :18 has to
    // read as the :15 chance or the rung silently cancels every retry — the
    // same indirection banter has needed since #1419. The window's opening
    // minutes are :15/:30/:45, deliberately never :00: that is the hourly time
    // check's, and letting both land on the hour stacked a station ID and an
    // hourly check back to back (and, with a between-track link, talking over
    // each other) — issue #310.
    const slot = openMinuteFor(talkSlot('station-id'), m);
    if (slot == null) return false;
    if (f === 'quiet')    return slot === 45;
    if (f === 'moderate') return slot === 15 || slot === 45;
    // Chatty and aggressive both ident at :15/:30/:45 (three an hour is the
    // ceiling); the rungs differ in link spacing, segment floors and banter
    // instead.
    return true;
  }

  if (kind === 'hourly') {
    // Station clock switch (settings.djSpeakClock). A segment whose whole
    // purpose is reading the time cannot honour "keep the clock off air" by
    // rewording, so it stands down instead. Gated HERE rather than inside
    // generateHourlyTime on purpose: manual /dj/segment runners never call
    // shouldFire, so the operator's own "Time check" pad keeps working and
    // still speaks the time — the same exemption 'silent' and the voice switch
    // already carry. Above the frequency ladder for the same reason as the
    // voice switch: it isn't a cadence, it's off.
    if (!autoTimeCheckAllowed()) return false;
    // Station-zone hour — the every-other-hour cadence follows the operator's
    // clock. The minute slots above stay on process time on purpose: they
    // must align with when the crons actually fire.
    if (f === 'quiet') return zonedParts(now).hour % 2 === 0;
    return true;
  }

  if (kind === 'banter') {
    // Guest-show banter breaks. Slots OPEN at :20/:50 — minutes the ident
    // (:15/:30/:45) and hourly (:00) crons never own, so an exchange can't be
    // scheduled against another wall-clock talker by construction — and each
    // stays open for a ten-minute window so an off-clock talk break postpones
    // the exchange instead of cancelling the hour (#1419). The window shape
    // lives in banter-policy.ts; this stays the frequency ladder only, and asks
    // it which slot the minute belongs to so a retry minute (:24) reads as the
    // same slot as its opening one (:20) rather than as no slot at all — the
    // same question the ident rung above now asks.
    const slot = openMinuteFor(talkSlot('banter'), m);
    if (slot == null) return false;
    // Banter is chatty by nature: a quiet persona never auto-fires it (the
    // operator's manual /dj/segment trigger still works), moderate gets at
    // most one an hour; chatty and aggressive get both slots.
    if (f === 'quiet')    return false;
    if (f === 'moderate') return slot === 20;
    return true;
  }

  return true;
}
