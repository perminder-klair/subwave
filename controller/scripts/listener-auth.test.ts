// Unit tests for the private-station auth decisions (util/listener-auth.ts).
//
// The load-bearing property here is that the two decisions have OPPOSITE
// failure modes on the same shared password, and that this is not an accident:
//
//   listenerAuthDecision (Icecast callback) fails OPEN when stream auth is off,
//   because icecast.xml only loses its <authentication> blocks on a broadcast
//   restart. Between "operator flips the toggle off" and "container comes back",
//   Icecast is still calling us on every connect — failing closed there would
//   lock out every listener until the restart landed.
//
//   stationAuthDecision (web UI gate) fails CLOSED, because privatePlayer can
//   be on while listenerAuth is off. If the UI reused the Icecast decision it
//   would take `enabled: false` and wave through ANY password, making the
//   player gate decorative.
//
// If someone ever "simplifies" these into one function, the assertions marked
// ASYMMETRY below are the ones that will catch it.
// Run: `tsx scripts/listener-auth.test.ts`.
//
// node:assert-via-tsx style, matching scripts/blocklist.test.ts.

import assert from 'node:assert/strict';

const { listenerAuthDecision, stationAuthDecision, mountAuthToken } =
  await import('../src/util/listener-auth.js');

const PW = 'hunter2-correct-horse';

// --- mountAuthToken -------------------------------------------------------

assert.equal(mountAuthToken('/stream.mp3'), '', 'no query → no token');
assert.equal(mountAuthToken('/stream.mp3?t=123'), '', 'query without auth → no token');
assert.equal(mountAuthToken(`/stream.mp3?auth=${PW}`), PW, 'bare auth param');
assert.equal(mountAuthToken(`/stream.mp3?t=1&auth=${PW}`), PW, 'auth after other params');
assert.equal(
  mountAuthToken('/stream.mp3?auth=a%2Bb%20c'),
  'a+b c',
  'percent-encoding is decoded',
);

// --- listenerAuthDecision: the Icecast contract ---------------------------

// Disconnect bookkeeping is never denied, whatever the state.
assert.equal(
  listenerAuthDecision({ enabled: true, password: PW, action: 'listener_remove' }),
  true,
  'listener_remove is always allowed',
);

// ASYMMETRY: auth off → allow everything. This is the restart-grace window.
assert.equal(
  listenerAuthDecision({ enabled: false, password: PW, pass: 'wrong' }),
  true,
  'Icecast path fails OPEN when stream auth is off (restart grace)',
);

// Auth on, no password on file → fail closed (settings validation prevents
// this state, but the endpoint must not hand out the stream if it happens).
assert.equal(
  listenerAuthDecision({ enabled: true, password: '', pass: 'anything' }),
  false,
  'enabled with no password on file denies',
);

// Both credential channels are accepted equivalently.
assert.equal(
  listenerAuthDecision({ enabled: true, password: PW, pass: PW }),
  true,
  'basic-auth pass field admits',
);
assert.equal(
  listenerAuthDecision({ enabled: true, password: PW, mount: `/stream.mp3?auth=${PW}` }),
  true,
  '?auth= mount token admits (the browser <audio> path)',
);
assert.equal(
  listenerAuthDecision({ enabled: true, password: PW, pass: 'nope', mount: '/stream.mp3' }),
  false,
  'wrong password denies',
);
// Length differences must not leak via an early return — the digest compare
// is what makes this uniform.
assert.equal(
  listenerAuthDecision({ enabled: true, password: PW, pass: 'x' }),
  false,
  'wrong password of a different length denies',
);
assert.equal(
  listenerAuthDecision({ enabled: true, password: PW, pass: '' }),
  false,
  'empty candidate denies',
);

// --- stationAuthDecision: the web UI contract -----------------------------

// Neither lock on → nothing to unlock.
assert.equal(
  stationAuthDecision({ privatePlayer: false, listenerAuth: false, password: PW }),
  true,
  'no locks engaged → open',
);

// ASYMMETRY: private player on, stream auth OFF. The Icecast decision would
// return true for any password here; the UI decision must not.
assert.equal(
  stationAuthDecision({
    privatePlayer: true,
    listenerAuth: false,
    password: PW,
    candidate: 'wrong',
  }),
  false,
  'UI path fails CLOSED with privatePlayer on and stream auth off',
);
assert.equal(
  stationAuthDecision({
    privatePlayer: true,
    listenerAuth: false,
    password: PW,
    candidate: PW,
  }),
  true,
  'correct password unlocks the private player',
);

// Stream auth alone also gates the UI overlay.
assert.equal(
  stationAuthDecision({
    privatePlayer: false,
    listenerAuth: true,
    password: PW,
    candidate: 'wrong',
  }),
  false,
  'stream-auth-only still rejects a wrong password in the UI',
);

// A lock on with no password on file fails closed both ways.
assert.equal(
  stationAuthDecision({ privatePlayer: true, listenerAuth: false, password: '', candidate: '' }),
  false,
  'privatePlayer with no password on file denies',
);
assert.equal(
  stationAuthDecision({ privatePlayer: false, listenerAuth: true, password: '', candidate: 'x' }),
  false,
  'listenerAuth with no password on file denies',
);

// Missing candidate is a denial, not a crash.
assert.equal(
  stationAuthDecision({ privatePlayer: true, listenerAuth: true, password: PW }),
  false,
  'absent candidate denies',
);

console.log('listener-auth.test.ts: all assertions passed');
