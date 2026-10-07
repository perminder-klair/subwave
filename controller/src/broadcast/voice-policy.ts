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

export function voiceStatus() {
  return { enabled: voiceEnabled() };
}
