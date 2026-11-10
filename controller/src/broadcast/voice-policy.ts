// Check the live voice switch before generation. Picks, requests, and jingles continue; manual
// segments bypass the switch.

import * as settings from '../settings.js';

// Absent/non-boolean reads as ON, so an upgrade changes nothing.
export function voiceEnabled(): boolean {
  return settings.get()?.tts?.enabled !== false;
}

// May an AUTONOMOUS talk moment start? Manual runners must NOT call this.
export function autoVoiceAllowed(): boolean {
  return voiceEnabled();
}

// May a track's own line (its link or request intro) air? The station switch
// decides, except for a line the operator asked for by hand (a steer's
// "Introduce on air", QueueItem.introByOperator): a manual trigger is exempt.
// The one reading for every queue backstop that renders, holds for or airs it.
export function trackLineVoiceAllowed(item: { introByOperator?: boolean } | null | undefined): boolean {
  return autoVoiceAllowed() || !!item?.introByOperator;
}

export function voiceStatus() {
  return { enabled: voiceEnabled() };
}
