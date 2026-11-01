// Tuning a listener back in after the station gate took them off the air, the
// app twin of web/lib/gateResume.ts: no package here imports another, so the
// rules are mirrored, and a change to them goes in both. The gate stops the
// audio when its prompt comes up, and the listener types the password to keep
// listening, so the right one puts them back on air with no second press.
//
// - Only a listener the gate itself interrupted is held. Someone who was never
//   tuned in, or who tuned out before the gate rose (a remote pause, the sleep
//   timer, their own stop), was not interrupted, and a password is no reason
//   to start audio for them.
// - The hold lasts as long as the gate. Once it is down it is spent, so it can
//   never answer for a later prompt: the listener's own stop stays a stop. The
//   web's station with no lock rests at 'checking', so that phase is the gate
//   only under a lock. This hook's goes to 'open', which is why only the web
//   needs it, and the rule is kept whole to stay a twin.
// - A hold belongs to one station. useStationGate outlives a switch, so it
//   keeps the `api` it held for, where the web's remounts with its player.
// - Only the controller's pass resumes: a wrong password keeps the hold for
//   the next try, and a 429 or an unavailable check leaves the audio stopped,
//   as the listener can still try again.

import type { StationAuthResult } from './station-password';

export interface GateAudioState {
  /** A lock is on. */
  required: boolean;
  /** The audio goes with the gate as soon as it rises, not when its prompt
   *  does: a web private player's <audio> unmounts with the face. Never true
   *  here, where the audio does not hang off the face. */
  takesAudio: boolean;
  phase: 'open' | 'checking' | 'prompt' | 'ok';
  tunedIn: boolean;
}

/** Whether the gate holds a listener to tune back in, given whether it did
 *  before this state. */
export function gateHolds(held: boolean, { required, takesAudio, phase, tunedIn }: GateAudioState): boolean {
  if (phase !== 'prompt' && !(required && phase === 'checking')) return false;
  if (!required || !tunedIn) return held;
  return phase === 'prompt' || takesAudio;
}

/** Whether this answer to a typed password tunes the held listener back in. */
export function resumeOnAnswer(held: boolean, result: StationAuthResult): boolean {
  return held && result === 'ok';
}
