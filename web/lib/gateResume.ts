// Tuning a listener back in after the station gate took them off the air, the web twin of
// app/src/lib/gate-resume.ts: no package here imports another, so the rules are mirrored, and a
// change to them goes in both. The gate stops the audio when its prompt comes up, and the listener
// types the password to keep listening, so the right one puts them back on air with no second press.
//
// - Only a listener the gate itself interrupted is held. Someone who was never tuned in, or who
//   tuned out before the gate rose (the idle cutoff, a Media Session pause, their own stop), was
//   not interrupted, and a password is no reason to start audio for them.
// - The hold lasts as long as the gate. Once it is down it is spent, so it can never answer for a
//   later prompt: the listener's own stop stays a stop. A station with no lock rests at 'checking'
//   here, so that phase is the gate only under a lock, as in lib/skinLock.ts: a lock lifted before
//   its check answered puts the face back with the gate down.
// - A hold belongs to one station and one mounted player. It lives in a ref that a showcase switch
//   remounts, and the app, whose hook outlives a switch, keys it by station. Any other tune-out
//   under the prompt drops it.
// - Only the controller's pass resumes: a wrong password keeps the hold for the next try, and a 429
//   or an unavailable check leaves the audio stopped, as the listener can still try again. A stored
//   password that passes the visit check resumes too (resumeOnStored), while one the check could
//   not verify opens the gate and starts nothing.

import type { StationAuthResult } from './stationAuth';

export interface GateAudioState {
  /** A lock is on. */
  required: boolean;
  /** The audio goes with the gate as soon as it rises, not when its prompt does: a private player's
   *  <audio> unmounts with the face, and by the prompt nothing says it was tuned in. Never true in
   *  the app, whose audio does not hang off its face. */
  takesAudio: boolean;
  phase: 'open' | 'checking' | 'prompt' | 'ok';
  tunedIn: boolean;
}

/** Whether the gate holds a listener to tune back in, given whether it did before this state. */
export function gateHolds(held: boolean, { required, takesAudio, phase, tunedIn }: GateAudioState): boolean {
  if (phase !== 'prompt' && !(required && phase === 'checking')) return false;
  if (!required || !tunedIn) return held;
  return phase === 'prompt' || takesAudio;
}

/** Whether this answer to a typed password tunes the held listener back in. */
export function resumeOnAnswer(held: boolean, result: StationAuthResult): boolean {
  return held && result === 'ok';
}

/** Whether the visit check's answer tunes the held listener back in. A private player's <audio> goes
 *  at 'checking', so a tap before the first /state is held and, with a good stored password, no
 *  prompt ever comes. The stream carries what is stored when it connects, so the pass must be for
 *  that password: another tab can change it while the check is out. The app has no twin of this:
 *  its audio stays up through the visit check, which so holds nobody. */
export function resumeOnStored(held: boolean, result: StationAuthResult, asked: string, stored: string): boolean {
  return resumeOnAnswer(held, result) && stored === asked;
}
