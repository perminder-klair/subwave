// Tuning a listener back in after the station gate took them off the air, mirroring
// app/scripts/gate-resume.test.ts. Each walk below is the hook's sequence of gate states, one
// effect run per step, so a test reads as what happened to the listener.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateHolds, resumeOnAnswer, resumeOnStored, type GateAudioState } from './gateResume';
import type { StationAuthResult } from './stationAuth';

type Step = Partial<GateAudioState>;

const LOCKED: GateAudioState = { required: true, takesAudio: false, phase: 'prompt', tunedIn: false };

/** The hold after these states in turn, each filled in from the one before. */
function walk(...steps: Step[]): boolean {
  let held = false;
  let state = LOCKED;
  for (const step of steps) {
    state = { ...state, ...step };
    held = gateHolds(held, state);
  }
  return held;
}

test('the stuck watcher\'s denial holds the listener it stopped', () => {
  assert.equal(walk({ phase: 'ok', tunedIn: true }, { phase: 'prompt' }, { tunedIn: false }), true);
});

test('a lock switched on mid-listen holds the listener once the prompt comes up', () => {
  assert.equal(
    walk({ required: false, phase: 'checking', tunedIn: true }, { required: true }, { phase: 'prompt' }, { tunedIn: false }),
    true,
  );
});

test('a tap before the first /state holds the listener on a listener-auth station', () => {
  assert.equal(walk({ required: false, phase: 'checking', tunedIn: true }, { required: true, phase: 'prompt' }, { tunedIn: false }), true);
});

test('a private player that takes the <audio> before its prompt still holds the listener', () => {
  assert.equal(
    walk(
      { required: false, phase: 'checking', tunedIn: true },
      // The render that unmounts the element: the player has not said so yet.
      { required: true, takesAudio: true },
      { tunedIn: false },
      { phase: 'prompt' },
    ),
    true,
  );
});

test('a stored password being checked over a stream lock holds nobody: the audio has not stopped', () => {
  assert.equal(walk({ required: true, phase: 'checking', tunedIn: true }), false);
});

test('a first visit holds nobody: the prompt comes before any tune-in', () => {
  assert.equal(walk({ phase: 'checking' }, { phase: 'prompt' }), false);
  assert.equal(walk({ takesAudio: true, phase: 'checking' }, { phase: 'prompt' }), false);
});

test('a listener already tuned out when the gate rises is not held', () => {
  // The idle cutoff, a Media Session pause or their own stop, with the denial still in flight.
  assert.equal(walk({ phase: 'ok', tunedIn: true }, { tunedIn: false }, { phase: 'prompt' }), false);
  assert.equal(walk({ phase: 'ok', tunedIn: true }, { tunedIn: false }, { takesAudio: true, phase: 'prompt' }), false);
});

test('a public station never holds anyone, though its phase stays at checking for good', () => {
  assert.equal(walk({ required: false, phase: 'checking', tunedIn: true }), false);
  assert.equal(walk({ required: false, takesAudio: false, phase: 'open', tunedIn: true }), false);
});

test('the prompt left up after the lock is lifted keeps the hold, and starts none', () => {
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, { required: false }), true);
  assert.equal(walk({ required: false, tunedIn: true }), false);
});

test('a lock lifted before its check answered drops the hold: the gate is down', () => {
  const rose: Step[] = [{ required: false, phase: 'checking', tunedIn: true }, { required: true, takesAudio: true }, { tunedIn: false }];
  assert.equal(walk(...rose, { required: false, takesAudio: false }), false);
  // Their own press and their own stop on the public station, then the next lock.
  assert.equal(
    walk(...rose, { required: false, takesAudio: false }, { tunedIn: true }, { tunedIn: false }, { required: true, takesAudio: true }),
    false,
  );
});

test('a listener back on air during a recheck has nothing left to resume', () => {
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, { phase: 'checking', tunedIn: true }), false);
});

test('a second try at the prompt keeps the hold', () => {
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, {}, {}), true);
});

test('the gate coming down spends the hold, so a later prompt finds nothing', () => {
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, { phase: 'ok' }), false);
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, { phase: 'open' }), false);
  // Their own stop, once the gate is down, then the next rotation.
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, { phase: 'ok' }, { phase: 'prompt' }), false);
});

test('only the controller\'s pass resumes, and only a held listener', () => {
  const answers: StationAuthResult[] = ['ok', 'denied', 'rate-limited', 'unavailable'];
  assert.deepEqual(answers.map(a => resumeOnAnswer(true, a)), [true, false, false, false]);
  assert.deepEqual(answers.map(a => resumeOnAnswer(false, a)), [false, false, false, false]);
});

test('the visit check resumes a held listener only on a pass for the password still stored', () => {
  assert.equal(resumeOnStored(true, 'ok', 'right', 'right'), true);
  assert.equal(resumeOnStored(false, 'ok', 'right', 'right'), false);
  // Kept and opened by the gate, but unverified, so nothing starts on it.
  for (const answer of ['denied', 'rate-limited', 'unavailable'] as const) {
    assert.equal(resumeOnStored(true, answer, 'right', 'right'), false);
  }
  // Another tab changed or forgot it while the check was out: the stream would carry something else.
  assert.equal(resumeOnStored(true, 'ok', 'right', 'newer'), false);
  assert.equal(resumeOnStored(true, 'ok', 'right', ''), false);
});
