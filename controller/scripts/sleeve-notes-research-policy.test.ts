import assert from 'node:assert/strict';
import test from 'node:test';
import { researchRunAllowed } from '../src/sleeve-notes/research-policy.js';

const activeStation = {
  playbackCriticalBusy: false, agentWorkActive: false, djCallsAllowed: true,
  pauseWhenEmpty: true, maintenanceWhenEmpty: false, listenerCount: 1,
};

test('Sleeve Notes research follows the normal DJ gate by default', () => {
  assert.equal(researchRunAllowed(activeStation), true);
  assert.equal(researchRunAllowed({ ...activeStation, djCallsAllowed: false, listenerCount: 0 }), false);
});

test('the empty-station maintenance option permits only confirmed-empty research', () => {
  const maintenance = { ...activeStation, djCallsAllowed: false, maintenanceWhenEmpty: true, listenerCount: 0 };
  assert.equal(researchRunAllowed(maintenance), true);
  assert.equal(researchRunAllowed({ ...maintenance, listenerCount: null }), false);
  assert.equal(researchRunAllowed({ ...maintenance, pauseWhenEmpty: false }), false);
});

test('empty-station maintenance still yields to playback and Agent work', () => {
  const maintenance = { ...activeStation, djCallsAllowed: false, maintenanceWhenEmpty: true, listenerCount: 0 };
  assert.equal(researchRunAllowed({ ...maintenance, playbackCriticalBusy: true }), false);
  assert.equal(researchRunAllowed({ ...maintenance, agentWorkActive: true }), false);
});

test('the station token cap blocks both ordinary and empty-station maintenance research',()=>{
 assert.equal(researchRunAllowed({...activeStation,researchBudgetAllowed:false}),false);
 assert.equal(researchRunAllowed({...activeStation,djCallsAllowed:false,listenerCount:0,maintenanceWhenEmpty:true,researchBudgetAllowed:false}),false);
});
