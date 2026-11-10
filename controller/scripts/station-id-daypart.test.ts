// Regression test for boundary-deferred station-ident dayparts.
// Run: `npm test -- station-id-daypart`.
//
// A scheduled ident is written at :15/:30/:45, rendered, then held for a
// track boundary. The queue may carry it across several voiced boundaries, so
// the daypart offered to the model must be stamped and compared with the live
// station daypart before the rendered clip airs. No stamp means the model was
// not offered a clock reading (for example, djSpeakClock is off), so there is
// no clock claim to invalidate.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  stationIdDaypartDrifted,
  stationIdDaypartStamp,
} from '../src/broadcast/clock-policy.js';

test('stamps only the daypart actually offered to the station-ident model', () => {
  assert.equal(stationIdDaypartStamp('in the afternoon', true), 'in the afternoon');
  assert.equal(stationIdDaypartStamp('in the afternoon', false), null);
  assert.equal(stationIdDaypartStamp('', true), null);
  assert.equal(stationIdDaypartStamp(null, true), null);
});

test('drops a deferred ident when its stamped daypart changed before air', () => {
  assert.equal(stationIdDaypartDrifted('in the afternoon', 'in the afternoon'), false);
  assert.equal(stationIdDaypartDrifted('in the afternoon', 'in the evening'), true);
  assert.equal(stationIdDaypartDrifted('at night', 'in the morning'), true);
});

test('a clockless ident has no daypart claim to invalidate', () => {
  assert.equal(stationIdDaypartDrifted(null, 'in the evening'), false);
  assert.equal(stationIdDaypartDrifted('', 'in the evening'), false);
});
