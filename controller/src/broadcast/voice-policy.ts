// Station-wide voice switch (`settings.tts.enabled`). Call sites ask; this
// module answers, so the policy lives in one place.
//
// The gate sits BEFORE generation, not at speak(), or the LLM writes every
// script and throws it away. Picks, listener requests and jingles keep running
// with voice off; only the spoken line is dropped. Manual /dj/segment triggers
// bypass this entirely. Read live, so the toggle applies on the next tick.

import * as settings from '../settings.js';

// Absent/non-boolean reads as ON, so an upgrade changes nothing.
export function voiceEnabled(): boolean {
  return settings.get()?.tts?.enabled !== false;
}

// May an AUTONOMOUS talk moment start? Manual runners must NOT call this.
export function autoVoiceAllowed(): boolean {
  return voiceEnabled();
}

export function voiceStatus() {
  return { enabled: voiceEnabled() };
}
