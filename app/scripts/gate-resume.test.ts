// Tuning a listener back in after the station gate took them off the air,
// mirroring web/lib/gateResume.test.ts. Each walk below is useStationGate's
// sequence of gate states, one effect run per step, so a test reads as what
// happened to the listener.

import assert from 'node:assert/strict';
import test from 'node:test';
import { gateHolds, resumeOnAnswer, type GateAudioState } from '../src/lib/gate-resume.ts';
import type { StationAuthResult } from '../src/lib/station-password.ts';

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

test("the stuck watcher's denial holds the listener it stopped", () => {
  assert.equal(walk({ phase: 'ok', tunedIn: true }, { phase: 'prompt' }, { tunedIn: false }), true);
});

test('a lock switched on mid-listen holds the listener once the prompt comes up', () => {
  assert.equal(
    walk({ required: false, phase: 'open', tunedIn: true }, { required: true }, { phase: 'checking' }, { phase: 'prompt' }, { tunedIn: false }),
    true,
  );
});

test('a tap before the first /state holds the listener', () => {
  assert.equal(
    walk({ required: false, phase: 'open', tunedIn: true }, { required: true, phase: 'checking' }, { phase: 'prompt' }, { tunedIn: false }),
    true,
  );
});

test('a forgotten password that brings the prompt back holds the listener', () => {
  assert.equal(walk({ phase: 'ok', tunedIn: true }, { phase: 'prompt' }, { tunedIn: false }), true);
});

test('a stored password being checked holds nobody: the audio has not stopped', () => {
  assert.equal(walk({ phase: 'checking', tunedIn: true }), false);
});

test('a private player holds nobody before its prompt: the app keeps the audio behind the face', () => {
  assert.equal(walk({ takesAudio: false, phase: 'checking', tunedIn: true }), false);
});

test('a web private player that takes the <audio> holds its listener, as the twin does', () => {
  assert.equal(walk({ takesAudio: true, phase: 'checking', tunedIn: true }, { tunedIn: false }, { phase: 'prompt' }), true);
});

test('a first visit holds nobody: the prompt comes before any tune-in', () => {
  assert.equal(walk({ phase: 'open' }, { phase: 'checking' }, { phase: 'prompt' }), false);
});

test('a listener already tuned out when the gate rises is not held', () => {
  // A remote pause, the sleep timer or their own stop, with the denial still in flight.
  assert.equal(walk({ phase: 'ok', tunedIn: true }, { tunedIn: false }, { phase: 'prompt' }), false);
});

test('a public station never holds anyone', () => {
  assert.equal(walk({ required: false, phase: 'open', tunedIn: true }), false);
});

test('the render a lock lifts in, with the prompt not yet gone, holds nobody new', () => {
  assert.equal(walk({ required: false, phase: 'prompt', tunedIn: true }), false);
});

test('a listener back on air during a recheck has nothing left to resume', () => {
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, { phase: 'checking', tunedIn: true }), false);
});

test('a second try at the prompt keeps the hold', () => {
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, {}, {}), true);
});

test('the gate coming down spends the hold, so a later prompt finds nothing', () => {
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, { phase: 'ok' }), false);
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, { required: false, phase: 'open' }), false);
  // Their own stop, once the gate is down, then the next rotation.
  assert.equal(walk({ tunedIn: true }, { tunedIn: false }, { phase: 'ok' }, { phase: 'prompt' }), false);
});

test("only the controller's pass resumes, and only a held listener", () => {
  const answers: StationAuthResult[] = ['ok', 'denied', 'rate-limited', 'unavailable'];
  assert.deepEqual(answers.map((a) => resumeOnAnswer(true, a)), [true, false, false, false]);
  assert.deepEqual(answers.map((a) => resumeOnAnswer(false, a)), [false, false, false, false]);
});
